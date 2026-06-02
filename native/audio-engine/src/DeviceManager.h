#pragma once

#include "AudioGraph.h"
#include <juce_audio_devices/juce_audio_devices.h>

namespace postadr
{
struct DeviceSummary
{
    juce::String id;
    juce::String name;
    juce::String backend;
    juce::String inputDeviceName;
    juce::String outputDeviceName;
    int inputChannelCount = 0;
    int outputChannelCount = 0;
    juce::StringArray availableInputDeviceNames;
    juce::StringArray inputChannelNames;
    juce::StringArray outputChannelNames;
    bool isProfessionalRoutingCapable = false;
};

class DeviceManager
{
public:
    DeviceManager();
    ~DeviceManager();

    juce::Array<DeviceSummary> listDevices();
    juce::Result openProfessionalDevice (const juce::String& deviceId, double sampleRate, int bufferSize);
    juce::Result openDiagnosticDevice (const juce::String& deviceId, double sampleRate, int bufferSize);
    juce::Result openDefaultDevice (double sampleRate, int bufferSize);
    void closeDevice();

    AudioGraph& getAudioGraph() noexcept;

private:
    juce::Result openDeviceUnchecked (const juce::String& deviceId, double sampleRate, int bufferSize);
    static juce::String chooseInputDeviceName (const juce::StringArray& inputNames, const juce::String& outputName);

    juce::AudioDeviceManager audioDeviceManager;
    AudioGraph audioGraph;
};
}
