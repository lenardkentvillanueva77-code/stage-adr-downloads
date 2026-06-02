#pragma once

#include <juce_audio_formats/juce_audio_formats.h>
#include <atomic>
#include <memory>
#include <vector>

namespace postadr
{
struct RecordLaneConfig
{
    juce::String laneId;
    juce::String label;
    int physicalInput = -1;
    juce::File destination;
};

struct RecordingFileStatus
{
    juce::String laneId;
    juce::String label;
    int physicalInput = -1;
    juce::String filePath;
    int64_t samplesWritten = 0;
    int64_t droppedBlocks = 0;
};

struct RecordingStatus
{
    bool active = false;
    int64_t samplesWritten = 0;
    int64_t droppedBlocks = 0;
    double sampleRate = 0.0;
    std::vector<RecordingFileStatus> files;
};

class NativeRecorder
{
public:
    NativeRecorder();
    ~NativeRecorder();

    juce::Result startRecording (const std::vector<RecordLaneConfig>& lanes, double sampleRate);
    RecordingStatus stop();
    void processInputBlock (const float* const* inputChannelData, int numInputChannels, int numSamples) noexcept;
    RecordingStatus getStatus() const noexcept;

private:
    struct ActiveLane
    {
        juce::String laneId;
        juce::String label;
        int physicalInput = -1;
        juce::String filePath;
        std::unique_ptr<juce::AudioFormatWriter::ThreadedWriter> writer;
        std::atomic<int64_t> samplesWritten { 0 };
        std::atomic<int64_t> droppedBlocks { 0 };
    };

    mutable juce::CriticalSection writerLock;
    juce::TimeSliceThread writerThread;
    std::vector<std::unique_ptr<ActiveLane>> activeLanes;
    std::atomic<bool> active { false };
    double activeSampleRate = 0.0;
};
}
