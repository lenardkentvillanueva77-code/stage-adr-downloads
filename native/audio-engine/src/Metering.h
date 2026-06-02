#pragma once

#include <juce_audio_basics/juce_audio_basics.h>
#include <array>
#include <atomic>

namespace postadr
{
class Metering
{
public:
    void process (const float* const* inputChannelData,
                  int inputChannels,
                  float* const* outputChannelData,
                  int outputChannels,
                  int numSamples) noexcept;

    std::array<float, 3> getInputPeaks() const noexcept;
    std::array<float, 4> getOutputPeaks() const noexcept;
    int getLastInputChannelCount() const noexcept;
    int getLastOutputChannelCount() const noexcept;
    int getLastBufferSize() const noexcept;
    int64_t getCallbackCount() const noexcept;

private:
    std::array<std::atomic<float>, 3> inputPeaks {};
    std::array<std::atomic<float>, 4> outputPeaks {};
    std::atomic<int> lastInputChannelCount { 0 };
    std::atomic<int> lastOutputChannelCount { 0 };
    std::atomic<int> lastBufferSize { 0 };
    std::atomic<int64_t> callbackCount { 0 };
};
}
