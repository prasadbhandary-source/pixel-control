# Pixel Control

See and control your Android phone (made for a Pixel 9 Pro) from a Windows computer over USB — an installable web app for Microsoft Edge or Google Chrome. No drivers or .exe needed.

**Open it:** https://prasadbhandary-source.github.io/pixel-control/

## Features
- Live, sharp mirror of the phone screen
- Mouse: click = tap, drag = swipe, wheel = scroll, right-click = Back, middle-click = Home
- Touchscreen: multi-touch, including pinch
- Keyboard typing into the phone; Ctrl+V pastes the computer's clipboard; text copied on the phone lands on the computer
- Buttons for Back, Home, Recents, volume, power, notifications, quick settings, rotate, phone-screen off, screenshot, full screen
- Drag files onto the phone to copy them to Download; APKs are installed
- Reconnects automatically when the phone is plugged in

## One-time phone setup
Settings → About phone → tap **Build number** 7 times; then Settings → System → Developer options → **USB debugging** on.

Built on [scrcpy](https://github.com/Genymobile/scrcpy) (Apache-2.0; `web/scrcpy-server.bin` is the official v3.3.3 server) and [Tango ADB](https://github.com/yume-chan/ya-webadb) (MIT).
