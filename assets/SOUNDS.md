# The press sounds

`soft.mp3` and `loud.mp3` are the sounds ok-rn plays when the soft key waits
for a press (android/app/src/main/java/com/okrn/emu/PressAlert.kt): soft every
2 s, loud every 3 s past 10 s, until the press or the key gives up.

- Source: https://audio.com/ - picked by Brad, 2026-10-03, from its
  "notification Sound Effects" collection, which the site describes as
  "free, high-quality notification sound effects in MP3 and WAV formats ...
  royalty-free SFX available for quick download and immediate use".
- Before an app-store release, keep a copy of each sound's own page and its
  licence terms with the release notes.
- To replace them: put new files here under the same names and rebuild; the
  build copies them into res/raw (the copyPressSounds task in
  android/app/build.gradle).
