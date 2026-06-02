#include "AudioGraph.h"
#include "Diagnostics.h"
#include <cmath>

namespace postadr
{
namespace
{
bool isOutputValid (int index, int numOutputChannels, float* const* outputChannelData) noexcept
{
    return index >= 0 && index < numOutputChannels && outputChannelData[index] != nullptr;
}

void addInputToOutput (const float* input, float* output, int numSamples, float gain) noexcept
{
    if (input == nullptr || output == nullptr || numSamples <= 0)
        return;

    if (gain == 1.0f)
        juce::FloatVectorOperations::add (output, input, numSamples);
    else
        juce::FloatVectorOperations::addWithMultiply (output, input, gain, numSamples);
}

void addInputToOutputPair (const float* input,
                           float* const* outputChannelData,
                           int numOutputChannels,
                           int leftOutput,
                           int rightOutput,
                           int numSamples,
                           float gain) noexcept
{
    const auto leftOutputValid = isOutputValid (leftOutput, numOutputChannels, outputChannelData);
    const auto rightOutputValid = isOutputValid (rightOutput, numOutputChannels, outputChannelData);

    if (leftOutputValid)
        addInputToOutput (input, outputChannelData[leftOutput], numSamples, gain);
    if (rightOutputValid && rightOutput != leftOutput)
        addInputToOutput (input, outputChannelData[rightOutput], numSamples, gain);
}
}

AudioGraph::AudioGraph()
{
    formatManager.registerBasicFormats();
}

void AudioGraph::audioDeviceIOCallbackWithContext (const float* const* inputChannelData,
                                                   int numInputChannels,
                                                   float* const* outputChannelData,
                                                   int numOutputChannels,
                                                   int numSamples,
                                                   const juce::AudioIODeviceCallbackContext&)
{
    for (int ch = 0; ch < numOutputChannels; ++ch)
        if (outputChannelData[ch] != nullptr)
            juce::FloatVectorOperations::clear (outputChannelData[ch], numSamples);

    recorder.processInputBlock (inputChannelData, numInputChannels, numSamples);
    processPlayback (outputChannelData, numOutputChannels, numSamples);
    processTones (outputChannelData, numOutputChannels, numSamples);
    processMonitoring (inputChannelData, numInputChannels, outputChannelData, numOutputChannels, numSamples);
    metering.process (inputChannelData, numInputChannels, outputChannelData, numOutputChannels, numSamples);
}

void AudioGraph::audioDeviceAboutToStart (juce::AudioIODevice* device)
{
    if (device != nullptr)
    {
        currentSampleRate.store (device->getCurrentSampleRate(), std::memory_order_relaxed);
        Diagnostics::info ("Audio device starting: " + device->getName());
    }
}

void AudioGraph::audioDeviceStopped()
{
    currentSampleRate.store (0.0, std::memory_order_relaxed);
    recorder.stop();
    stopAllPlayback();
    stopAllTones();
    clearMonitoring();
    clearTalkback();
    Diagnostics::info ("Audio device stopped");
}

Metering& AudioGraph::getMetering() noexcept
{
    return metering;
}

NativeRecorder& AudioGraph::getRecorder() noexcept
{
    return recorder;
}

double AudioGraph::getCurrentSampleRate() const noexcept
{
    return currentSampleRate.load (std::memory_order_relaxed);
}

void AudioGraph::setMonitorLane (int laneIndex, bool enabled, int physicalInput, float gain) noexcept
{
    if (laneIndex < 0 || laneIndex >= static_cast<int> (monitorEnabled.size()))
        return;

    monitorPhysicalInput[static_cast<size_t> (laneIndex)].store (physicalInput, std::memory_order_release);
    monitorGain[static_cast<size_t> (laneIndex)].store (juce::jlimit (0.0f, 2.0f, gain), std::memory_order_release);
    monitorEnabled[static_cast<size_t> (laneIndex)].store (enabled, std::memory_order_release);
}

void AudioGraph::clearMonitoring() noexcept
{
    for (int i = 0; i < static_cast<int> (monitorEnabled.size()); ++i)
        setMonitorLane (i, false, -1, 1.0f);
}

void AudioGraph::setOutputRouting (int controlLeft, int controlRight, int boothLeft, int boothRight) noexcept
{
    controlLeftOutput.store (controlLeft, std::memory_order_release);
    controlRightOutput.store (controlRight, std::memory_order_release);
    boothLeftOutput.store (boothLeft, std::memory_order_release);
    boothRightOutput.store (boothRight, std::memory_order_release);
}

void AudioGraph::setTalkback (bool enabled, int physicalInput, float gain) noexcept
{
    talkbackPhysicalInput.store (physicalInput, std::memory_order_release);
    talkbackGain.store (juce::jlimit (0.0f, 2.0f, gain), std::memory_order_release);
    talkbackEnabled.store (enabled, std::memory_order_release);
}

void AudioGraph::clearTalkback() noexcept
{
    setTalkback (false, -1, 1.0f);
}

juce::Result AudioGraph::loadPlaybackClip (const juce::File& file, std::shared_ptr<AudioClip>& clip)
{
    if (! file.existsAsFile())
        return juce::Result::fail ("Playback file not found: " + file.getFullPathName());

    const auto cacheKey = file.getFullPathName();
    {
        const juce::ScopedLock lock (playbackCacheLock);
        if (auto it = playbackCache.find (cacheKey); it != playbackCache.end())
        {
            clip = it->second;
            return juce::Result::ok();
        }
    }

    auto reader = std::unique_ptr<juce::AudioFormatReader> (formatManager.createReaderFor (file));
    if (! reader)
        return juce::Result::fail ("Could not read playback file: " + file.getFullPathName());

    auto loaded = std::make_shared<AudioClip>();
    loaded->sourceSampleRate = reader->sampleRate;
    loaded->buffer.setSize (static_cast<int> (reader->numChannels),
                            static_cast<int> (reader->lengthInSamples));
    reader->read (&loaded->buffer, 0, static_cast<int> (reader->lengthInSamples), 0, true, true);

    {
        const juce::ScopedLock lock (playbackCacheLock);
        playbackCache[cacheKey] = loaded;
    }

    clip = std::move (loaded);
    return juce::Result::ok();
}

juce::Result AudioGraph::preparePlayback (const juce::File& file)
{
    std::shared_ptr<AudioClip> clip;
    return loadPlaybackClip (file, clip);
}

juce::Result AudioGraph::startPlayback (const juce::String& playbackId,
                                        const juce::File& file,
                                        double offsetSeconds,
                                        float gain,
                                        const juce::String& target)
{
    if (playbackId.isEmpty())
        return juce::Result::fail ("playback.start requires playbackId.");

    if (currentSampleRate.load (std::memory_order_relaxed) <= 0.0)
        return juce::Result::fail ("No active audio device for playback.");

    if (target.isNotEmpty()
        && target != "auto"
        && target != "control"
        && target != "booth"
        && target != "both")
        return juce::Result::fail ("Invalid playback target: " + target);

    std::shared_ptr<AudioClip> clip;
    if (const auto result = loadPlaybackClip (file, clip); result.failed())
        return result;

    auto voice = std::make_unique<PlaybackVoice>();
    voice->clip = std::move (clip);
    voice->position = juce::jmax (0.0, offsetSeconds) * voice->clip->sourceSampleRate;
    voice->gain = juce::jlimit (0.0f, 2.0f, gain);
    voice->target = target.isNotEmpty() ? target : "auto";

    const juce::ScopedLock lock (playbackLock);
    playbackVoices[playbackId] = std::move (voice);
    return juce::Result::ok();
}

void AudioGraph::stopPlayback (const juce::String& playbackId)
{
    const juce::ScopedLock lock (playbackLock);
    playbackVoices.erase (playbackId);
}

void AudioGraph::stopAllPlayback()
{
    const juce::ScopedLock lock (playbackLock);
    playbackVoices.clear();
}

juce::Result AudioGraph::scheduleTone (const juce::String& toneId,
                                       double delaySeconds,
                                       double frequencyHz,
                                       double durationSeconds,
                                       float gain,
                                       const juce::String& target)
{
    const auto sampleRate = currentSampleRate.load (std::memory_order_relaxed);
    if (toneId.isEmpty())
        return juce::Result::fail ("tone.schedule requires toneId.");
    if (sampleRate <= 0.0)
        return juce::Result::fail ("No active audio device for tone scheduling.");
    if (frequencyHz <= 0.0 || durationSeconds <= 0.0)
        return juce::Result::fail ("Invalid tone frequency or duration.");

    ToneVoice tone;
    tone.samplesUntilStart = static_cast<int> (juce::jmax (0.0, delaySeconds) * sampleRate);
    tone.samplesRemaining = static_cast<int> (durationSeconds * sampleRate);
    tone.phaseDelta = juce::MathConstants<double>::twoPi * frequencyHz / sampleRate;
    tone.gain = juce::jlimit (0.0f, 2.0f, gain);
    tone.target = target.isNotEmpty() ? target : "auto";

    const juce::ScopedLock lock (toneLock);
    toneVoices[toneId] = tone;
    return juce::Result::ok();
}

void AudioGraph::stopTone (const juce::String& toneId)
{
    const juce::ScopedLock lock (toneLock);
    toneVoices.erase (toneId);
}

void AudioGraph::stopAllTones()
{
    const juce::ScopedLock lock (toneLock);
    toneVoices.clear();
}

void AudioGraph::addSampleToTargetOutputs (float sample,
                                           float* const* outputChannelData,
                                           int numOutputChannels,
                                           const juce::String& target,
                                           int frame) const noexcept
{
    const auto addToPair = [&] (int left, int right, int skipLeft = -2, int skipRight = -2)
    {
        if (left != skipLeft && left != skipRight && isOutputValid (left, numOutputChannels, outputChannelData))
            outputChannelData[left][frame] += sample;
        if (right != left && right != skipLeft && right != skipRight && isOutputValid (right, numOutputChannels, outputChannelData))
            outputChannelData[right][frame] += sample;
    };

    const auto controlLeft = controlLeftOutput.load (std::memory_order_acquire);
    const auto controlRight = controlRightOutput.load (std::memory_order_acquire);
    const auto boothLeft = boothLeftOutput.load (std::memory_order_acquire);
    const auto boothRight = boothRightOutput.load (std::memory_order_acquire);

    if (target == "both")
    {
        addToPair (controlLeft, controlRight);
        addToPair (boothLeft, boothRight, controlLeft, controlRight);
        return;
    }

    if (target == "booth" || (target == "auto" && ! isOutputValid (controlLeft, numOutputChannels, outputChannelData)))
        addToPair (boothLeft, boothRight);
    else
        addToPair (controlLeft, controlRight);
}

void AudioGraph::processPlayback (float* const* outputChannelData,
                                  int numOutputChannels,
                                  int numSamples) noexcept
{
    const auto destinationSampleRate = currentSampleRate.load (std::memory_order_relaxed);
    if (outputChannelData == nullptr || numOutputChannels <= 0 || numSamples <= 0 || destinationSampleRate <= 0.0)
        return;

    const juce::ScopedLock lock (playbackLock);

    for (auto it = playbackVoices.begin(); it != playbackVoices.end();)
    {
        auto& voice = *it->second;
        if (! voice.clip)
        {
            it = playbackVoices.erase (it);
            continue;
        }

        const auto channels = voice.clip->buffer.getNumChannels();
        const auto sourceSamples = voice.clip->buffer.getNumSamples();
        const auto ratio = voice.clip->sourceSampleRate > 0.0 ? voice.clip->sourceSampleRate / destinationSampleRate : 1.0;

        for (int frame = 0; frame < numSamples; ++frame)
        {
            const auto sourceIndex = static_cast<int> (voice.position);
            if (sourceIndex >= sourceSamples)
                break;

            float sample = 0.0f;
            if (channels == 1)
                sample = voice.clip->buffer.getSample (0, sourceIndex);
            else
                sample = 0.5f * (voice.clip->buffer.getSample (0, sourceIndex)
                              + voice.clip->buffer.getSample (1, sourceIndex));

            addSampleToTargetOutputs (sample * voice.gain, outputChannelData, numOutputChannels, voice.target, frame);
            voice.position += ratio;
        }

        if (voice.position >= sourceSamples)
            it = playbackVoices.erase (it);
        else
            ++it;
    }
}

void AudioGraph::processTones (float* const* outputChannelData,
                               int numOutputChannels,
                               int numSamples) noexcept
{
    if (outputChannelData == nullptr || numOutputChannels <= 0 || numSamples <= 0)
        return;

    const juce::ScopedLock lock (toneLock);

    for (auto it = toneVoices.begin(); it != toneVoices.end();)
    {
        auto& tone = it->second;
        for (int frame = 0; frame < numSamples; ++frame)
        {
            if (tone.samplesUntilStart > 0)
            {
                --tone.samplesUntilStart;
                continue;
            }

            if (tone.samplesRemaining <= 0)
                break;

            const auto sample = std::sin (tone.phase) * tone.gain;
            addSampleToTargetOutputs (static_cast<float> (sample), outputChannelData, numOutputChannels, tone.target, frame);
            tone.phase += tone.phaseDelta;
            if (tone.phase > juce::MathConstants<double>::twoPi)
                tone.phase -= juce::MathConstants<double>::twoPi;
            --tone.samplesRemaining;
        }

        if (tone.samplesRemaining <= 0)
            it = toneVoices.erase (it);
        else
            ++it;
    }
}

void AudioGraph::processMonitoring (const float* const* inputChannelData,
                                    int numInputChannels,
                                    float* const* outputChannelData,
                                    int numOutputChannels,
                                    int numSamples) noexcept
{
    if (inputChannelData == nullptr || outputChannelData == nullptr || numSamples <= 0 || numOutputChannels <= 0)
        return;

    const auto controlLeft = controlLeftOutput.load (std::memory_order_acquire);
    const auto controlRight = controlRightOutput.load (std::memory_order_acquire);
    const auto boothLeft = boothLeftOutput.load (std::memory_order_acquire);
    const auto boothRight = boothRightOutput.load (std::memory_order_acquire);
    const auto controlOutputValid = isOutputValid (controlLeft, numOutputChannels, outputChannelData)
                                 || isOutputValid (controlRight, numOutputChannels, outputChannelData);
    const auto boothOutputValid = isOutputValid (boothLeft, numOutputChannels, outputChannelData)
                               || isOutputValid (boothRight, numOutputChannels, outputChannelData);

    if (! controlOutputValid && ! boothOutputValid)
        return;

    for (int laneIndex = 0; laneIndex < static_cast<int> (monitorEnabled.size()); ++laneIndex)
    {
        if (! monitorEnabled[static_cast<size_t> (laneIndex)].load (std::memory_order_acquire))
            continue;

        const auto inputIndex = monitorPhysicalInput[static_cast<size_t> (laneIndex)].load (std::memory_order_acquire);
        if (inputIndex < 0 || inputIndex >= numInputChannels)
            continue;

        const auto* input = inputChannelData[inputIndex];
        const auto gain = monitorGain[static_cast<size_t> (laneIndex)].load (std::memory_order_acquire);
        if (controlOutputValid)
            addInputToOutputPair (input, outputChannelData, numOutputChannels, controlLeft, controlRight, numSamples, gain);
        if (boothOutputValid && (boothLeft != controlLeft || boothRight != controlRight))
            addInputToOutputPair (input, outputChannelData, numOutputChannels, boothLeft, boothRight, numSamples, gain);
    }

    if (talkbackEnabled.load (std::memory_order_acquire))
    {
        const auto inputIndex = talkbackPhysicalInput.load (std::memory_order_acquire);
        if (inputIndex >= 0 && inputIndex < numInputChannels)
        {
            const auto* input = inputChannelData[inputIndex];
            const auto gain = talkbackGain.load (std::memory_order_acquire);
            if (boothOutputValid)
                addInputToOutputPair (input, outputChannelData, numOutputChannels, boothLeft, boothRight, numSamples, gain);
        }
    }
}
}
