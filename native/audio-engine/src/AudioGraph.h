#pragma once

#include "Metering.h"
#include "NativeRecorder.h"
#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <map>
#include <memory>

namespace postadr
{
class AudioGraph final : public juce::AudioIODeviceCallback
{
public:
    AudioGraph();

    struct MonitorLane
    {
        bool enabled = false;
        int physicalInput = -1;
        float gain = 1.0f;
    };

    void audioDeviceIOCallbackWithContext (const float* const* inputChannelData,
                                           int numInputChannels,
                                           float* const* outputChannelData,
                                           int numOutputChannels,
                                           int numSamples,
                                           const juce::AudioIODeviceCallbackContext& context) override;

    void audioDeviceAboutToStart (juce::AudioIODevice* device) override;
    void audioDeviceStopped() override;

    Metering& getMetering() noexcept;
    NativeRecorder& getRecorder() noexcept;
    double getCurrentSampleRate() const noexcept;
    void setMonitorLane (int laneIndex, bool enabled, int physicalInput, float gain = 1.0f) noexcept;
    void clearMonitoring() noexcept;
    void setOutputRouting (int controlLeft, int controlRight, int boothLeft, int boothRight) noexcept;
    void setTalkback (bool enabled, int physicalInput, float gain = 1.0f) noexcept;
    void clearTalkback() noexcept;
    juce::Result startPlayback (const juce::String& playbackId,
                                const juce::File& file,
                                double offsetSeconds,
                                float gain,
                                const juce::String& target);
    juce::Result preparePlayback (const juce::File& file);
    void stopPlayback (const juce::String& playbackId);
    void stopAllPlayback();
    juce::Result scheduleTone (const juce::String& toneId,
                               double delaySeconds,
                               double frequencyHz,
                               double durationSeconds,
                               float gain,
                               const juce::String& target);
    void stopTone (const juce::String& toneId);
    void stopAllTones();

private:
    struct AudioClip
    {
        juce::AudioBuffer<float> buffer;
        double sourceSampleRate = 0.0;
    };

    struct PlaybackVoice
    {
        std::shared_ptr<AudioClip> clip;
        double position = 0.0;
        float gain = 1.0f;
        juce::String target;
    };

    struct ToneVoice
    {
        int samplesUntilStart = 0;
        int samplesRemaining = 0;
        double phase = 0.0;
        double phaseDelta = 0.0;
        float gain = 1.0f;
        juce::String target;
    };

    void processMonitoring (const float* const* inputChannelData,
                            int numInputChannels,
                            float* const* outputChannelData,
                            int numOutputChannels,
                            int numSamples) noexcept;
    void processPlayback (float* const* outputChannelData,
                          int numOutputChannels,
                          int numSamples) noexcept;
    void processTones (float* const* outputChannelData,
                       int numOutputChannels,
                       int numSamples) noexcept;
    void addSampleToTargetOutputs (float sample,
                                   float* const* outputChannelData,
                                   int numOutputChannels,
                                   const juce::String& target,
                                   int frame) const noexcept;
    juce::Result loadPlaybackClip (const juce::File& file, std::shared_ptr<AudioClip>& clip);

    Metering metering;
    NativeRecorder recorder;
    juce::AudioFormatManager formatManager;
    juce::CriticalSection playbackCacheLock;
    std::map<juce::String, std::shared_ptr<AudioClip>> playbackCache;
    juce::CriticalSection playbackLock;
    std::map<juce::String, std::unique_ptr<PlaybackVoice>> playbackVoices;
    juce::CriticalSection toneLock;
    std::map<juce::String, ToneVoice> toneVoices;
    std::atomic<double> currentSampleRate { 0.0 };
    std::array<std::atomic<bool>, 2> monitorEnabled {};
    std::array<std::atomic<int>, 2> monitorPhysicalInput {};
    std::array<std::atomic<float>, 2> monitorGain {};
    std::atomic<int> controlLeftOutput { 0 };
    std::atomic<int> controlRightOutput { 1 };
    std::atomic<int> boothLeftOutput { 2 };
    std::atomic<int> boothRightOutput { 3 };
    std::atomic<bool> talkbackEnabled { false };
    std::atomic<int> talkbackPhysicalInput { -1 };
    std::atomic<float> talkbackGain { 1.0f };
};
}
