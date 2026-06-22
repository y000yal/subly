# Privacy Policy — Captiv

**Last updated: June 12, 2026**

## What Captiv does

Captiv is a Chrome extension that enables Picture-in-Picture for any video on any website and mirrors the site's own subtitles into the floating window. It works entirely inside your browser.

## Data we collect

**None.** Captiv does not collect, store, transmit, or share any personal data, browsing history, video content, or subtitle text.

## What Captiv stores locally

Captiv saves your subtitle display preferences (font size, font family, text color, background color, background opacity, subtitle position, and edge style) to your browser's local storage using the `chrome.storage.local` API. This data:

- Never leaves your device
- Is never sent to any server
- Is not accessible to any website or third party
- Can be cleared at any time by removing the extension

## Why Captiv requests broad host permissions

Captiv declares access to all URLs (`<all_urls>`) for one reason only: to detect the video element and read the enabled subtitle track on whichever page you are watching. This is required because videos can live on any website, including inside embedded players on third-party domains. Captiv's injected code is inert until you activate it by clicking the toolbar button or pressing Alt+P.

Captiv does not read, record, or transmit any page content, form data, passwords, or browsing activity.

## Third parties

Captiv has no backend, no analytics, no crash reporting, and no third-party SDKs. Nothing is sent anywhere.

## Changes to this policy

If this policy changes in a future version, the updated date at the top will reflect it. Significant changes will be noted in the extension's changelog.

## Contact

Questions or concerns: [yoyal.limbu@themegrill.com](mailto:yoyal.limbu@themegrill.com)  
Source code: [https://github.com/y000yal/subly](https://github.com/y000yal/subly)
