cmake_minimum_required(VERSION 3.22.1)
project(okssl C CXX)

# OKSSL_OPENSSL: the release AAR's prefab/modules/openssl (build.gradle fetches,
# checks and unpacks it). libcrypto is linked statically: only what okssl.cpp
# calls ends up in libokssl.so.
if(NOT OKSSL_OPENSSL)
  message(FATAL_ERROR "OKSSL_OPENSSL is not set - build through Gradle (okssl/build.gradle)")
endif()

add_library(okssl_crypto STATIC IMPORTED)
set_target_properties(okssl_crypto PROPERTIES
  IMPORTED_LOCATION ${OKSSL_OPENSSL}/libs/android.${ANDROID_ABI}/libcrypto.a)

add_library(okssl SHARED src/main/cpp/okssl.cpp)
target_include_directories(okssl PRIVATE ${OKSSL_OPENSSL}/include)
target_compile_features(okssl PRIVATE cxx_std_17)
target_link_libraries(okssl okssl_crypto log)
# Hide everything but the JNI entry points.
set_target_properties(okssl PROPERTIES CXX_VISIBILITY_PRESET hidden)
target_link_options(okssl PRIVATE -Wl,--exclude-libs,ALL -Wl,--gc-sections)
