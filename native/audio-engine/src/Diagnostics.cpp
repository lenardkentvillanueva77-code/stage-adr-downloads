#include "Diagnostics.h"

namespace postadr
{
void Diagnostics::info (const juce::String& message)
{
    juce::Logger::writeToLog ("[audio-engine] " + message);
}

void Diagnostics::error (const juce::String& message)
{
    juce::Logger::writeToLog ("[audio-engine:error] " + message);
}
}

