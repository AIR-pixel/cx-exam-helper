# 构建 LSPosed 模块 APK（com.air.skipmodule）
#
# 关键点：
#  1) xposed API 是 compileOnly。stub 只参与 javac 的 classpath，
#     产物必须落在独立目录，绝不能进 d8 的输入 —— 否则假实现会被打进 APK，
#     覆盖 LSPosed 注入的真实现，模块直接失效。
#  2) assets\xposed_init 必须用 aapt2 的 -A 打进去，LSPosed 靠它找入口类。
#     缺了它模块会「装了但完全不生效」。
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File build-module.ps1

$ErrorActionPreference = 'Stop'

$SDK  = 'C:\Users\air\AppData\Local\Android\Sdk'
$BT   = "$SDK\build-tools\34.0.0"
$BT37 = "$SDK\build-tools\37.0.0"
$JDK  = 'C:\Program Files\Microsoft\jdk-21.0.7.6-hotspot\bin'
$JAR  = "$SDK\platforms\android-35\android.jar"
$HERE = $PSScriptRoot
$KS   = Join-Path (Split-Path $HERE -Parent) 'mpdemo\debug.keystore'
$OUT  = Join-Path $HERE 'build'
$STUB = Join-Path $HERE 'xposed-api-stub'

if (Test-Path $OUT) { Remove-Item $OUT -Recurse -Force }
New-Item -ItemType Directory -Path "$OUT\classes","$OUT\stub-classes","$OUT\gen" -Force | Out-Null

Write-Host "=== aapt2 link ===" -ForegroundColor Cyan
& "$BT\aapt2.exe" link -o "$OUT\base.apk" -I $JAR --manifest (Join-Path $HERE 'AndroidManifest.xml') `
    --java "$OUT\gen" --min-sdk-version 30 --target-sdk-version 35 --auto-add-overlay `
    -A (Join-Path $HERE 'assets')
if ($LASTEXITCODE -ne 0) { throw "aapt2 link 失败" }

Write-Host "=== javac stub（仅 classpath，不进 APK）===" -ForegroundColor Cyan
$stubSrcs = @(Get-ChildItem (Join-Path $STUB 'src') -Recurse -Filter '*.java' | ForEach-Object { $_.FullName })
$eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
& "$JDK\javac.exe" -source 8 -target 8 -classpath $JAR -d "$OUT\stub-classes" -encoding UTF-8 -nowarn @stubSrcs 2>&1 | Out-Null
$rc = $LASTEXITCODE; $ErrorActionPreference = $eap
if ($rc -ne 0) { throw "javac stub 失败 (exit $rc)" }

Write-Host "=== javac module ===" -ForegroundColor Cyan
$srcs = @(Get-ChildItem $HERE -Filter '*.java' -File | ForEach-Object { $_.FullName })
$srcs += @(Get-ChildItem "$OUT\gen" -Recurse -Filter '*.java' | ForEach-Object { $_.FullName })
$cp = "$JAR;$OUT\stub-classes"

$eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
& "$JDK\javac.exe" -source 8 -target 8 -classpath $cp -d "$OUT\classes" -encoding UTF-8 -nowarn @srcs 2>&1 | Out-Null
$rc = $LASTEXITCODE; $ErrorActionPreference = $eap
if ($rc -ne 0) { throw "javac module 失败 (exit $rc)" }

Write-Host "=== d8（只打 module 的 class）===" -ForegroundColor Cyan
& "$JDK\java.exe" -cp "$BT37\lib\d8.jar" com.android.tools.r8.D8 --min-api 30 --output $OUT --lib $JAR `
    (Get-ChildItem "$OUT\classes" -Recurse -Filter '*.class' | ForEach-Object { $_.FullName })
if ($LASTEXITCODE -ne 0) { throw "d8 失败" }

Write-Host "=== 打包 dex ===" -ForegroundColor Cyan
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open("$OUT\base.apk", 'Update')
$e = $zip.GetEntry('classes.dex'); if ($e) { $e.Delete() }
[System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, "$OUT\classes.dex", 'classes.dex', 'Optimal') | Out-Null
$zip.Dispose()

Write-Host "=== 检查 assets\xposed_init ===" -ForegroundColor Cyan
$xposedInit = Join-Path $HERE 'assets\xposed_init'
if (Test-Path $xposedInit) {
    Write-Host ("  entry: " + (Get-Content $xposedInit -Raw).Trim())
} else {
    Write-Host "  [!] assets\xposed_init 缺失 —— 模块加载后不会生效" -ForegroundColor Yellow
}

Write-Host "=== 对齐 + 签名 ===" -ForegroundColor Cyan
& "$BT\zipalign.exe" -f -p 4 "$OUT\base.apk" "$OUT\aligned.apk"
if ($LASTEXITCODE -ne 0) { throw "zipalign 失败" }
& "$BT\apksigner.bat" sign --ks $KS --ks-pass pass:android --key-pass pass:android `
    --ks-key-alias androiddebugkey --out "$OUT\signed.apk" "$OUT\aligned.apk"
if ($LASTEXITCODE -ne 0) { throw "apksigner 失败" }

$f = Get-Item "$OUT\signed.apk"
Write-Host ("OK  {0}  {1} bytes" -f $f.Name, $f.Length) -ForegroundColor Green