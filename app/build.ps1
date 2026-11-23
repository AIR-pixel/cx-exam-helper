# 构建 answer-app + exam-mock
#
# 用法（PowerShell，工作目录任意）：
#   pwsh -File build.ps1
#
# 工具链（本机实测路径）：
#   aapt2 / apksigner  C:\Users\air\AppData\Local\Android\Sdk\build-tools\34.0.0
#   d8                 C:\Users\air\AppData\Local\Android\Sdk\build-tools\37.0.0   ← 34 的 d8 在 JDK21 上抛 NPE
#   javac              C:\Program Files\Microsoft\jdk-21.0.7.6-hotspot\bin
#   android.jar        C:\Users\air\AppData\Local\Android\Sdk\platforms\android-35\android.jar

$ErrorActionPreference = 'Stop'

$SDK  = 'C:\Users\air\AppData\Local\Android\Sdk'
$BT   = "$SDK\build-tools\34.0.0"
$BT37 = "$SDK\build-tools\37.0.0"
$JDK  = 'C:\Program Files\Microsoft\jdk-21.0.7.6-hotspot\bin'
$JAR  = "$SDK\platforms\android-35\android.jar"
$HERE = $PSScriptRoot
$KS   = Join-Path (Split-Path $HERE -Parent) 'mpdemo\debug.keystore'

function Build-Apk {
    param([string]$Name, [string]$SrcDir)

    Write-Host "`n=== $Name ===" -ForegroundColor Cyan
    $out = Join-Path $HERE "build\$Name"
    if (Test-Path $out) { Remove-Item $out -Recurse -Force }
    New-Item -ItemType Directory -Path "$out\classes","$out\gen" -Force | Out-Null

    # 1 资源
    $resDir = Join-Path $SrcDir 'res'
    $hasRes = (Test-Path $resDir) -and (Get-ChildItem $resDir -Recurse -File).Count -gt 0
    $resArg = @()
    if ($hasRes) {
        & "$BT\aapt2.exe" compile --dir $resDir -o "$out\res.zip"
        if ($LASTEXITCODE -ne 0) { throw "aapt2 compile 失败" }
        $resArg = @('-R', "$out\res.zip")
    }

    $manifest = Join-Path $SrcDir 'AndroidManifest.xml'
    & "$BT\aapt2.exe" link -o "$out\base.apk" -I $JAR --manifest $manifest `
        @resArg --java "$out\gen" --min-sdk-version 30 --target-sdk-version 35 --auto-add-overlay
    if ($LASTEXITCODE -ne 0) { throw "aapt2 link 失败" }

    # 2 java
    $srcs = @(Get-ChildItem (Join-Path $SrcDir 'src') -Recurse -Filter '*.java' | ForEach-Object { $_.FullName })
    $srcs += @(Get-ChildItem "$out\gen" -Recurse -Filter '*.java' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
    if ($srcs.Count -eq 0) { throw "没有 .java 源文件" }

    # javac 把「过时 API」提示写 stderr，PowerShell 会当成 NativeCommandError，
# 所以临时放宽 ErrorActionPreference，只看退出码。
    $eap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & "$JDK\javac.exe" -source 8 -target 8 -classpath $JAR -d "$out\classes" `
        -encoding UTF-8 -nowarn @srcs 2>&1 | Out-Null
    $rc = $LASTEXITCODE
    $ErrorActionPreference = $eap
    if ($rc -ne 0) { throw "javac 失败 (exit $rc)" }

    # 3 dex（必须用 37 的 d8）
    & "$JDK\java.exe" -cp "$BT37\lib\d8.jar" com.android.tools.r8.D8 --min-api 30 `
        --output $out --lib $JAR `
        (Get-ChildItem "$out\classes" -Recurse -Filter '*.class' | ForEach-Object { $_.FullName })
    if ($LASTEXITCODE -ne 0) { throw "d8 失败" }

    # 4 把 dex 塞进 apk
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::Open("$out\base.apk", 'Update')
    $entry = $zip.GetEntry('classes.dex')
    if ($entry) { $entry.Delete() }
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $zip, "$out\classes.dex", 'classes.dex', 'Optimal') | Out-Null
    $zip.Dispose()

    # 5 对齐 + 签名
    & "$BT\zipalign.exe" -f -p 4 "$out\base.apk" "$out\aligned.apk"
    if ($LASTEXITCODE -ne 0) { throw "zipalign 失败" }

    & "$BT\apksigner.bat" sign --ks $KS --ks-pass pass:android --key-pass pass:android `
        --ks-key-alias androiddebugkey --out "$out\signed.apk" "$out\aligned.apk"
    if ($LASTEXITCODE -ne 0) { throw "apksigner 失败" }

    $f = Get-Item "$out\signed.apk"
    Write-Host ("OK  {0}  {1} bytes" -f $f.Name, $f.Length) -ForegroundColor Green
    return $f.FullName
}

$a = Build-Apk -Name 'answer-app' -SrcDir $HERE
$b = Build-Apk -Name 'exam-mock'  -SrcDir (Join-Path (Split-Path $HERE -Parent) 'mock')

Write-Host "`n=== 产物 ===" -ForegroundColor Yellow
Write-Host "answer : $a"
Write-Host "exam   : $b"