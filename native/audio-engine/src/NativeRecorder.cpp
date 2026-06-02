#include "NativeRecorder.h"

#include <set>

namespace postadr
{
NativeRecorder::NativeRecorder()
    : writerThread ("Post ADR Native Recording Writer")
{
    writerThread.startThread();
}

NativeRecorder::~NativeRecorder()
{
    stop();
    writerThread.stopThread (5000);
}

juce::Result NativeRecorder::startRecording (const std::vector<RecordLaneConfig>& lanes, double sampleRate)
{
    if (sampleRate <= 0.0)
        return juce::Result::fail ("Audio device sample rate is not available.");

    if (lanes.empty())
        return juce::Result::fail ("No record lanes are armed.");

    {
        const juce::ScopedLock lock (writerLock);
        if (! activeLanes.empty())
            return juce::Result::fail ("Recording is already active.");
    }

    std::set<int> physicalInputs;
    std::vector<std::unique_ptr<ActiveLane>> nextLanes;

    for (const auto& config : lanes)
    {
        if (config.laneId.isEmpty())
            return juce::Result::fail ("Armed record lane is missing laneId.");

        if (config.physicalInput < 0)
            return juce::Result::fail ("Armed record lane is missing a physical input.");

        if (! physicalInputs.insert (config.physicalInput).second)
            return juce::Result::fail ("Two record lanes cannot use the same physical input.");

        const auto parent = config.destination.getParentDirectory();
        if (! parent.exists() && ! parent.createDirectory())
            return juce::Result::fail ("Could not create recording directory: " + parent.getFullPathName());

        if (config.destination.existsAsFile() && ! config.destination.deleteFile())
            return juce::Result::fail ("Could not replace existing recording file: " + config.destination.getFullPathName());

        auto stream = config.destination.createOutputStream();
        if (stream == nullptr || stream->failedToOpen())
            return juce::Result::fail ("Could not open WAV file for writing: " + config.destination.getFullPathName());

        juce::WavAudioFormat wavFormat;
        auto writer = std::unique_ptr<juce::AudioFormatWriter> (
            wavFormat.createWriterFor (stream.release(), sampleRate, 1, 24, {}, 0));

        if (writer == nullptr)
            return juce::Result::fail ("Could not create WAV writer for: " + config.destination.getFullPathName());

        auto lane = std::make_unique<ActiveLane>();
        lane->laneId = config.laneId;
        lane->label = config.label.isNotEmpty() ? config.label : config.laneId;
        lane->physicalInput = config.physicalInput;
        lane->filePath = config.destination.getFullPathName();
        lane->writer = std::make_unique<juce::AudioFormatWriter::ThreadedWriter> (writer.release(),
                                                                                  writerThread,
                                                                                  32768);
        nextLanes.push_back (std::move (lane));
    }

    const juce::ScopedLock lock (writerLock);
    activeSampleRate = sampleRate;
    activeLanes = std::move (nextLanes);
    active.store (true, std::memory_order_release);

    return juce::Result::ok();
}

RecordingStatus NativeRecorder::stop()
{
    RecordingStatus status;

    {
        const juce::ScopedLock lock (writerLock);
        active.store (false, std::memory_order_release);
        status.sampleRate = activeSampleRate;
        status.active = false;

        for (const auto& lane : activeLanes)
        {
            RecordingFileStatus file;
            file.laneId = lane->laneId;
            file.label = lane->label;
            file.physicalInput = lane->physicalInput;
            file.filePath = lane->filePath;
            file.samplesWritten = lane->samplesWritten.load (std::memory_order_relaxed);
            file.droppedBlocks = lane->droppedBlocks.load (std::memory_order_relaxed);
            status.samplesWritten = juce::jmax (status.samplesWritten, file.samplesWritten);
            status.droppedBlocks += file.droppedBlocks;
            status.files.push_back (file);
        }

        activeLanes.clear();
        activeSampleRate = 0.0;
    }

    return status;
}

void NativeRecorder::processInputBlock (const float* const* inputChannelData,
                                        int numInputChannels,
                                        int numSamples) noexcept
{
    if (! active.load (std::memory_order_acquire) || inputChannelData == nullptr || numSamples <= 0)
        return;

    const juce::ScopedLock lock (writerLock);

    for (auto& lane : activeLanes)
    {
        if (lane->writer == nullptr)
            continue;

        const auto inputIndex = lane->physicalInput;
        if (inputIndex < 0 || inputIndex >= numInputChannels || inputChannelData[inputIndex] == nullptr)
        {
            lane->droppedBlocks.fetch_add (1, std::memory_order_relaxed);
            continue;
        }

        const float* channels[] = { inputChannelData[inputIndex] };
        if (lane->writer->write (channels, numSamples))
            lane->samplesWritten.fetch_add (numSamples, std::memory_order_relaxed);
        else
            lane->droppedBlocks.fetch_add (1, std::memory_order_relaxed);
    }
}

RecordingStatus NativeRecorder::getStatus() const noexcept
{
    RecordingStatus status;
    const juce::ScopedLock lock (writerLock);
    status.active = active.load (std::memory_order_acquire);
    status.sampleRate = activeSampleRate;

    for (const auto& lane : activeLanes)
    {
        RecordingFileStatus file;
        file.laneId = lane->laneId;
        file.label = lane->label;
        file.physicalInput = lane->physicalInput;
        file.filePath = lane->filePath;
        file.samplesWritten = lane->samplesWritten.load (std::memory_order_relaxed);
        file.droppedBlocks = lane->droppedBlocks.load (std::memory_order_relaxed);
        status.samplesWritten = juce::jmax (status.samplesWritten, file.samplesWritten);
        status.droppedBlocks += file.droppedBlocks;
        status.files.push_back (file);
    }

    return status;
}
}
