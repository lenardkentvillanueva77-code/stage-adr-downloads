#include "Metering.h"
#include <algorithm>
#include <cmath>

namespace postadr
{
namespace
{
float peakForChannel (const float* samples, int numSamples) noexcept
{
    if (samples == nullptr || numSamples <= 0)
        return 0.0f;

    float peak = 0.0f;
    for (int i = 0; i < numSamples; ++i)
        peak = std::max (peak, std::abs (samples[i]));

    return peak;
}
}

void Metering::process (const float* const* inputChannelData,
                        int inputChannels,
                        float* const* outputChannelData,
                        int outputChannels,
                        int numSamples) noexcept
{
    lastInputChannelCount.store (inputChannels, std::memory_order_relaxed);
    lastOutputChannelCount.store (outputChannels, std::memory_order_relaxed);
    lastBufferSize.store (numSamples, std::memory_order_relaxed);
    callbackCount.fetch_add (1, std::memory_order_relaxed);

    for (int ch = 0; ch < static_cast<int> (inputPeaks.size()); ++ch)
    {
        const auto peak = ch < inputChannels ? peakForChannel (inputChannelData[ch], numSamples) : 0.0f;
        inputPeaks[static_cast<size_t> (ch)].store (peak, std::memory_order_relaxed);
    }

    for (int ch = 0; ch < static_cast<int> (outputPeaks.size()); ++ch)
    {
        const auto peak = ch < outputChannels ? peakForChannel (outputChannelData[ch], numSamples) : 0.0f;
        outputPeaks[static_cast<size_t> (ch)].store (peak, std::memory_order_relaxed);
    }
}

std::array<float, 3> Metering::getInputPeaks() const noexcept
{
    return {
        inputPeaks[0].load (std::memory_order_relaxed),
        inputPeaks[1].load (std::memory_order_relaxed),
        inputPeaks[2].load (std::memory_order_relaxed)
    };
}

std::array<float, 4> Metering::getOutputPeaks() const noexcept
{
    return {
        outputPeaks[0].load (std::memory_order_relaxed),
        outputPeaks[1].load (std::memory_order_relaxed),
        outputPeaks[2].load (std::memory_order_relaxed),
        outputPeaks[3].load (std::memory_order_relaxed)
    };
}

int Metering::getLastInputChannelCount() const noexcept
{
    return lastInputChannelCount.load (std::memory_order_relaxed);
}

int Metering::getLastOutputChannelCount() const noexcept
{
    return lastOutputChannelCount.load (std::memory_order_relaxed);
}

int Metering::getLastBufferSize() const noexcept
{
    return lastBufferSize.load (std::memory_order_relaxed);
}

int64_t Metering::getCallbackCount() const noexcept
{
    return callbackCount.load (std::memory_order_relaxed);
}
}
