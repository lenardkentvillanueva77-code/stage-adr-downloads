#pragma once

namespace postadr
{
struct StudioRoutingProfile
{
    static constexpr int adrMic1Input = 0;
    static constexpr int adrMic2Input = 1;
    static constexpr int talkbackInput = 2;

    static constexpr int controlLeftOutput = 0;
    static constexpr int controlRightOutput = 1;
    static constexpr int boothLeftOutput = 2;
    static constexpr int boothRightOutput = 3;

    static constexpr int requiredInputChannels = 3;
    static constexpr int requiredOutputChannels = 4;

    static bool isProfessionalRoutingCapable (int inputChannels, int outputChannels);
};
}

