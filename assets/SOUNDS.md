# The press sounds

`soft.mp3` and `loud.mp3` are the sounds ok-rn plays when the soft key waits
for a press (android/app/src/main/java/com/okrn/emu/PressAlert.kt): soft every
2 s, loud every 3 s past 10 s, until the press or the key gives up.

- Source: https://audio.com/ - picked by Brad, 2026-10-03.
- Each sound on audio.com carries its own licence. Check both files' licences
  before an app-store release.
- To replace them: put new files here under the same names and rebuild; the
  build copies them into res/raw (the copyPressSounds task in
  android/app/build.gradle).
