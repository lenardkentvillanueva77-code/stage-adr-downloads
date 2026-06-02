cmake_minimum_required(VERSION 3.22)

project(PostAdrAudioEngine VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(JUCE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/JUCE" CACHE PATH "Path to JUCE checkout")

if(NOT EXISTS "${JUCE_DIR}/CMakeLists.txt")
  message(FATAL_ERROR
    "JUCE was not found at ${JUCE_DIR}. "
    "Clone or vendor JUCE into native/audio-engine/JUCE before configuring.")
endif()

add_subdirectory("${JUCE_DIR}" JUCE)

juce_add_console_app(PostAdrAudioEngine
  PRODUCT_NAME "Post ADR Pro Audio Engine"
)

target_sources(PostAdrAudioEngine
  PRIVATE
    src/main.cpp
    src/EngineApp.cpp
    src/EngineIPC.cpp
    src/DeviceManager.cpp
    src/StudioRoutingProfile.cpp
    src/AudioGraph.cpp
    src/NativeRecorder.cpp
    src/Metering.cpp
    src/Diagnostics.cpp
)

target_include_directories(PostAdrAudioEngine
  PRIVATE
    src
)

target_compile_definitions(PostAdrAudioEngine
  PRIVATE
    JUCE_WEB_BROWSER=0
    JUCE_USE_CURL=0
    JUCE_ASIO=1
)

target_link_libraries(PostAdrAudioEngine
  PRIVATE
    juce::juce_audio_basics
    juce::juce_audio_devices
    juce::juce_audio_formats
    juce::juce_audio_utils
    juce::juce_core
    juce::juce_events
    juce::juce_recommended_config_flags
    juce::juce_recommended_lto_flags
    juce::juce_recommended_warning_flags
)
