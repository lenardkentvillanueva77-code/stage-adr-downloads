#include "DeviceManager.h"
#include "Diagnostics.h"
#include "StudioRoutingProfile.h"
#include <memory>

namespace postadr
{
namespace
{
juce::String parentheticalToken (const juce::String& name)
{
    const auto open = name.indexOfChar ('(');
    const auto close = name.lastIndexOfChar (')');
    if (open >= 0 && close > open)
        return name.substring (open + 1, close).trim().toLowerCase();

    return {};
}

int commonTokenCount (const juce::String& a, const juce::String& b)
{
    const auto aTokens = juce::StringArray::fromTokens (a.toLowerCase().retainCharacters ("abcdefghijklmnopqrstuvwxyz0123456789 "), " ", "");
    const auto bTokens = juce::StringArray::fromTokens (b.toLowerCase().retainCharacters ("abcdefghijklmnopqrstuvwxyz0123456789 "), " ", "");

    int count = 0;
    for (const auto& token : aTokens)
        if (token.length() >= 4 && bTokens.contains (token))
            ++count;

    return count;
}
}

DeviceManager::DeviceManager()
{
    audioDeviceManager.addAudioCallback (&audioGraph);
}

DeviceManager::~DeviceManager()
{
    audioDeviceManager.removeAudioCallback (&audioGraph);
}

juce::Array<DeviceSummary> DeviceManager::listDevices()
{
    juce::Array<DeviceSummary> summaries;

    auto& types = audioDeviceManager.getAvailableDeviceTypes();

    for (auto* type : types)
    {
        if (type == nullptr)
            continue;

        type->scanForDevices();

        const auto backend = type->getTypeName();
        const auto inputNames = type->getDeviceNames (true);
        const auto outputNames = type->getDeviceNames (false);

        for (const auto& outputName : outputNames)
        {
            const auto inputName = chooseInputDeviceName (inputNames, outputName);

            DeviceSummary summary;
            summary.id = backend + ":" + outputName;
            summary.name = outputName;
            summary.backend = backend;
            summary.inputDeviceName = inputName;
            summary.outputDeviceName = outputName;
            summary.availableInputDeviceNames = inputNames;

            if (auto device = std::unique_ptr<juce::AudioIODevice> (type->createDevice (outputName, inputName)))
            {
                summary.inputChannelNames = device->getInputChannelNames();
                summary.outputChannelNames = device->getOutputChannelNames();
                summary.inputChannelCount = summary.inputChannelNames.size();
                summary.outputChannelCount = summary.outputChannelNames.size();
            }
            else if (inputNames.contains (outputName))
            {
                summary.inputChannelCount = 1;
            }

            summary.isProfessionalRoutingCapable =
                StudioRoutingProfile::isProfessionalRoutingCapable (summary.inputChannelCount,
                                                                    summary.outputChannelCount);

            summaries.add (summary);
        }
    }

    return summaries;
}

juce::Result DeviceManager::openProfessionalDevice (const juce::String& deviceId, double sampleRate, int bufferSize)
{
    const auto separator = deviceId.indexOfChar (':');
    if (separator <= 0)
        return juce::Result::fail ("Invalid deviceId.");

    const auto backend = deviceId.substring (0, separator);
    const auto outputName = deviceId.substring (separator + 1);

    for (auto* type : audioDeviceManager.getAvailableDeviceTypes())
    {
        if (type == nullptr || type->getTypeName() != backend)
            continue;

        type->scanForDevices();
        const auto inputNames = type->getDeviceNames (true);
        const auto inputName = chooseInputDeviceName (inputNames, outputName);

        auto probe = std::unique_ptr<juce::AudioIODevice> (type->createDevice (outputName, inputName));
        if (! probe)
            return juce::Result::fail ("Could not create device: " + outputName);

        const auto inputCount = probe->getInputChannelNames().size();
        const auto outputCount = probe->getOutputChannelNames().size();

        if (! StudioRoutingProfile::isProfessionalRoutingCapable (inputCount, outputCount))
            return juce::Result::fail ("Device does not expose required 3 inputs and 4 outputs.");

        return openDeviceUnchecked (deviceId, sampleRate, bufferSize);
    }

    return juce::Result::fail ("Device backend not found: " + backend);
}

juce::Result DeviceManager::openDiagnosticDevice (const juce::String& deviceId, double sampleRate, int bufferSize)
{
    return openDeviceUnchecked (deviceId, sampleRate, bufferSize);
}

juce::Result DeviceManager::openDeviceUnchecked (const juce::String& deviceId, double sampleRate, int bufferSize)
{
    const auto separator = deviceId.indexOfChar (':');
    if (separator <= 0)
        return juce::Result::fail ("Invalid deviceId.");

    const auto backend = deviceId.substring (0, separator);
    const auto outputName = deviceId.substring (separator + 1);

    for (auto* type : audioDeviceManager.getAvailableDeviceTypes())
    {
        if (type == nullptr || type->getTypeName() != backend)
            continue;

        type->scanForDevices();
        const auto inputNames = type->getDeviceNames (true);
        const auto inputName = chooseInputDeviceName (inputNames, outputName);

        auto probe = std::unique_ptr<juce::AudioIODevice> (type->createDevice (outputName, inputName));
        if (! probe)
            return juce::Result::fail ("Could not create device: " + outputName);

        const auto inputCount = probe->getInputChannelNames().size();
        const auto outputCount = probe->getOutputChannelNames().size();

        if (inputCount <= 0 && outputCount <= 0)
            return juce::Result::fail ("Device exposes no input or output channels.");

        juce::AudioDeviceManager::AudioDeviceSetup setup;
        audioDeviceManager.getAudioDeviceSetup (setup);
        setup.inputDeviceName = inputName;
        setup.outputDeviceName = outputName;
        setup.sampleRate = sampleRate;
        setup.bufferSize = bufferSize;
        setup.useDefaultInputChannels = false;
        setup.useDefaultOutputChannels = false;
        setup.inputChannels.clear();
        setup.inputChannels.setRange (0, inputCount, true);
        setup.outputChannels.clear();
        setup.outputChannels.setRange (0, outputCount, true);

        audioDeviceManager.setCurrentAudioDeviceType (backend, true);
        const auto initResult = audioDeviceManager.initialise (inputCount,
                                                               outputCount,
                                                               nullptr,
                                                               true,
                                                               {},
                                                               &setup);

        if (initResult.isNotEmpty())
            return juce::Result::fail (initResult);

        Diagnostics::info ("Opened device: " + outputName);
        return juce::Result::ok();
    }

    return juce::Result::fail ("Device backend not found: " + backend);
}

juce::Result DeviceManager::openDefaultDevice (double sampleRate, int bufferSize)
{
    juce::AudioDeviceManager::AudioDeviceSetup setup;
    audioDeviceManager.getAudioDeviceSetup (setup);
    setup.sampleRate = sampleRate;
    setup.bufferSize = bufferSize;
    setup.useDefaultInputChannels = false;
    setup.useDefaultOutputChannels = false;
    setup.inputChannels.clear();
    setup.inputChannels.setRange (0, StudioRoutingProfile::requiredInputChannels, true);
    setup.outputChannels.clear();
    setup.outputChannels.setRange (0, StudioRoutingProfile::requiredOutputChannels, true);

    const auto result = audioDeviceManager.initialise (StudioRoutingProfile::requiredInputChannels,
                                                       StudioRoutingProfile::requiredOutputChannels,
                                                       nullptr,
                                                       true,
                                                       {},
                                                       &setup);

    if (result.isNotEmpty())
        return juce::Result::fail (result);

    if (auto* device = audioDeviceManager.getCurrentAudioDevice())
    {
        const auto inputCount = device->getInputChannelNames().size();
        const auto outputCount = device->getOutputChannelNames().size();

        if (! StudioRoutingProfile::isProfessionalRoutingCapable (inputCount, outputCount))
        {
            closeDevice();
            return juce::Result::fail ("Default device does not expose the required 3 inputs and 4 outputs.");
        }

        Diagnostics::info ("Opened default device: " + device->getName());
        return juce::Result::ok();
    }

    return juce::Result::fail ("No current audio device after initialise.");
}

void DeviceManager::closeDevice()
{
    audioDeviceManager.closeAudioDevice();
}

AudioGraph& DeviceManager::getAudioGraph() noexcept
{
    return audioGraph;
}

juce::String DeviceManager::chooseInputDeviceName (const juce::StringArray& inputNames, const juce::String& outputName)
{
    if (inputNames.contains (outputName))
        return outputName;

    const auto outputToken = parentheticalToken (outputName);
    if (outputToken.isNotEmpty())
    {
        for (const auto& inputName : inputNames)
            if (parentheticalToken (inputName) == outputToken)
                return inputName;

        for (const auto& inputName : inputNames)
        {
            const auto inputToken = parentheticalToken (inputName);
            const auto inputLower = inputName.toLowerCase();

            if (inputLower.contains (outputToken)
                || (inputToken.isNotEmpty() && (outputToken.contains (inputToken) || inputToken.contains (outputToken))))
                return inputName;
        }
    }

    const auto outputLower = outputName.toLowerCase();
    for (const auto& inputName : inputNames)
    {
        const auto inputLower = inputName.toLowerCase();
        if (outputLower.contains (inputLower)
            || inputLower.contains (outputLower)
            || commonTokenCount (outputLower, inputLower) >= 1)
            return inputName;
    }

    return inputNames.isEmpty() ? juce::String() : inputNames[0];
}
}
