#!/system/bin/sh
echo "=== keyguard ==="
dumpsys window 2>/dev/null | grep -iE "mDreamingLockscreen|mShowingLockscreen|keyguardShowing|isStatusBarKeyguard" | head -5
echo
echo "=== CE / DE unlocked ==="
dumpsys user 2>/dev/null | grep -iE "unlocked|CE|DE" | head -8
echo
echo "=== device provisioned ==="
settings get global device_provisioned
settings get secure user_setup_complete
echo
echo "=== current focus ==="
dumpsys window 2>/dev/null | grep -i "mCurrentFocus\|mFocusedApp" | head -3
echo
echo "=== vold decrypt ==="
getprop vold.decrypt
getprop sys.user.0.ce_available