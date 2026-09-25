@echo off
rem
rem Compile the OnlyKey JCA provider.
rem
rem javac and nothing else. This is five source files with no dependencies
rem beyond the JDK, and it is loaded by apksigner rather than by the app, so a
rem Gradle module would add a build graph, a manifest and a lifecycle to
rem something that needs none of them.
rem
rem Output goes to .local\classes, which is gitignored along with everything
rem else this tool generates.
rem
setlocal

set HERE=%~dp0
set OUT=%HERE%.local\classes

if defined JAVA_HOME (
  set JAVAC="%JAVA_HOME%\bin\javac.exe"
) else (
  set JAVAC=javac
)

if not exist "%OUT%" mkdir "%OUT%" || exit /b 1

rem -Xlint:-options silences the "no -bootclasspath" note; --release 17 pins
rem the language level so this cannot start depending on a newer JDK by
rem accident on somebody else's machine.
%JAVAC% --release 17 -Xlint:all -d "%OUT%" ^
  "%HERE%OnlyKeyPrivateKey.java" ^
  "%HERE%OnlyKeyBackend.java" ^
  "%HERE%OnlyKeySignature.java" ^
  "%HERE%OnlyKeyKeyStore.java" ^
  "%HERE%OnlyKeyProvider.java" || exit /b 1

echo built: %OUT%
