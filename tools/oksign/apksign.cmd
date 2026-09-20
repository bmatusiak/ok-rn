@echo off
rem
rem apksigner, but able to see our provider.
rem
rem THE REASON THIS WRAPPER EXISTS. apksigner.bat launches the tool with
rem `java -jar apksigner.jar`, and -jar makes the JVM ignore CLASSPATH
rem entirely - the jar's own Class-Path is the whole world. So
rem --ks-provider-class com.okrn.signer.OnlyKeyProvider can never be resolved
rem through the stock launcher, no matter what CLASSPATH says.
rem
rem Invoking the same main class with -cp instead fixes it and changes nothing
rem else: com.android.apksigner.ApkSignerTool is what the jar's manifest names
rem as Main-Class, so this is the identical entry point with a wider classpath.
rem
rem Everything after the script name is passed through untouched.
rem
setlocal

set HERE=%~dp0
set CLASSES=%HERE%.local\classes

if not exist "%CLASSES%" (
  echo apksign: the provider is not built - run tools\oksign\build.cmd first 1>&2
  exit /b 1
)

rem The SDK is found the way Gradle finds it, rather than hardcoding a
rem build-tools version that is current today and stale next year.
call :find_sdk
if not defined BUILD_TOOLS (
  echo apksign: could not locate Android build-tools ^(set ANDROID_HOME or sdk.dir^) 1>&2
  exit /b 1
)

if defined JAVA_HOME (
  set JAVA="%JAVA_HOME%\bin\java.exe"
) else (
  set JAVA=java
)

%JAVA% -cp "%BUILD_TOOLS%\lib\apksigner.jar;%CLASSES%" com.android.apksigner.ApkSignerTool %*
exit /b %ERRORLEVEL%

:find_sdk
set SDK=
if defined ANDROID_HOME set SDK=%ANDROID_HOME%
if not defined SDK (
  rem android\local.properties is what Gradle itself reads.
  for /f "tokens=1,* delims==" %%a in ('findstr /b "sdk.dir" "%HERE%..\..\android\local.properties" 2^>nul') do set SDK=%%b
)
if not defined SDK set SDK=%LOCALAPPDATA%\Android\Sdk
rem Gradle escapes the colon in local.properties as C\:/Users/...
set SDK=%SDK:\:=:%
set SDK=%SDK:/=\%
if not exist "%SDK%\build-tools" exit /b 0
rem Last directory wins: `dir /b /o:n` sorts ascending, so the newest is last.
for /f "delims=" %%d in ('dir /b /o:n "%SDK%\build-tools" 2^>nul') do set BUILD_TOOLS=%SDK%\build-tools\%%d
exit /b 0
