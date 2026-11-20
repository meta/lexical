# Lexical DevTools browser extension

This is the source code for the Lexical DevTools browser extension.

[link-chrome]: https://chromewebstore.google.com/detail/lexical-developer-tools/kgljmdocanfjckcgfpcpdoklodllfdpc 'Version published on Chrome Web Store'
[link-firefox]: https://addons.mozilla.org/en-US/firefox/addon/lexical-developer-tools/ 'Version published on Mozilla Add-ons'

[<img src="https://cdnjs.cloudflare.com/ajax/libs/browser-logos/74.1.0/chrome/chrome.svg" width="48" alt="Chrome logo" valign="middle">][link-chrome] [<img valign="middle" src="https://img.shields.io/chrome-web-store/v/kgljmdocanfjckcgfpcpdoklodllfdpc?style=flat&label=%20">][link-chrome]

[<img src="https://cdnjs.cloudflare.com/ajax/libs/browser-logos/74.1.0/firefox/firefox.svg" width="48" alt="Firefox logo" valign="middle">][link-firefox] [<img valign="middle" src="https://img.shields.io/amo/v/lexical-developer-tools.svg?label=%20">][link-firefox]

## Local development

Lexical DevTools extension uses [WXT](https://wxt.dev/) framework to simplify development. Please refer to [WXT Development Guide](https://wxt.dev/guide/introduction.html) for comprehensive documentation.

**TLDR:**
```bash
$ pnpm run dev
# In browser: Alt+R to force reload extension
```

**Useful Hints:**
- Extension activity log: [chrome://extensions/?activity=eddfjidloofnnmloonifcjkpmfmlblab](chrome://extensions/?activity=eddfjidloofnnmloonifcjkpmfmlblab)
- Status of ServiceWorkers: [chrome://serviceworker-internals/?devtools](chrome://serviceworker-internals/?devtools)
- WXT Framework debugging: `DEBUG_WXT=1 pnpm run dev`
- If you detach the Dev Tools in a separate window, and press `Cmd+Option+I` while Dev Tools window is focused, you will invoke the Dev Tools for the Dev Tools window.

**Safari:**

To develop and run Safari version of the extension you (obviously) need a Mac and Xcode installed. Safari on the contrary to other browsers doesn't accept web extensions as a zip archive but rather requires you to [wrap it in native code (Swift) wrapper](https://developer.apple.com/documentation/safariservices/safari_web_extensions/converting_a_web_extension_for_safari/). Fortunately this process is mostly automated here.

```bash
# Install Xcode

# Environment setup
sudo xcode-select -s /Applications/Xcode.app
xcodebuild --install
sudo xcodebuild -license
xcodebuild -runFirstLaunch

# Normal operation
pnpm run dev:safari
```

The Safari extension is no longer published: the Mac App Store listing has been taken down, so `dev:safari` builds it for local use only.

## Publishing

Production (`latest`) npm releases submit Chrome and Firefox extensions for review from the released commit, with build version `0`. Update store screenshots/videos before releases that change the UI.

For extension-only releases or retries, run [Publish DevTools extension to stores](https://github.com/meta/lexical/actions/workflows/devtools-extension-publish.yml) on the release tag. Increase "Build version" for repeated uploads of the same Lexical version (`<version>.<build_version>`), and wait for pending Chrome reviews to finish. Store submissions can fail independently; retry this workflow without republishing npm packages.

### Store credentials

Chrome publishes through the Chrome Web Store API with a [service account](https://console.cloud.google.com/iam-admin/serviceaccounts?project=lexical-devtools) from the `lexical-devtools` Google Cloud project, linked to the listing's publisher under **Service account** in the [Developer Dashboard Settings page](https://chrome.google.com/webstore/devconsole/f0fd8a71-2d57-4015-b897-d9e628e2e143/settings). Configure these [repository settings](https://github.com/meta/lexical/settings/variables/actions):

| Setting | Type | Value |
| --- | --- | --- |
| `EXTENSION_CHROME_EXTENSION_ID` | Secret | Listing's extension ID |
| `EXTENSION_CHROME_PUBLISHER_ID` | Variable | Publisher ID on the [Developer Dashboard Settings page](https://chrome.google.com/webstore/devconsole/f0fd8a71-2d57-4015-b897-d9e628e2e143/settings) |
| `EXTENSION_CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL` | Variable | Service account's `client_email`, also listed under **Service account** on that page |
| `EXTENSION_CHROME_SERVICE_ACCOUNT_PRIVATE_KEY` | Secret | Decoded `private_key` PEM with actual newlines, not the full JSON key |

Firefox requires repository secrets `EXTENSION_FIREFOX_EXTENSION_ID`, `EXTENSION_FIREFOX_JWT_ISSUER`, and `EXTENSION_FIREFOX_JWT_SECRET`.

Confirm Chrome visibility and rollout in the Developer Dashboard. Visibility changes require one manual publish before API publishing. `wxt submit --dry-run` contacts Google.

#### Rotating the Chrome service account key

The key does not expire, so rotate it only when it leaks or a key holder leaves. This needs the **Owner** role on the `lexical-devtools` project.

1. On the service account's [Keys tab](https://console.cloud.google.com/iam-admin/serviceaccounts/details/103203520135244394615/keys?project=lexical-devtools), choose **Add key > Create new key > JSON**. The key file downloads.
2. Print the PEM. The JSON holds it on one line with literal `\n`, and the secret needs real newlines:

   ```bash
   python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["private_key"])' ~/Downloads/<key>.json
   ```

3. Paste that output, including the `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` lines, into the `EXTENSION_CHROME_SERVICE_ACCOUNT_PRIVATE_KEY` secret.
4. Delete the downloaded JSON file, then delete the superseded key from the Keys tab.
5. Run the publish workflow with a higher build version to confirm the new key works.

#### Google Cloud access (maintainers)

Only project owners can create service account keys. To add one, open [IAM for `lexical-devtools`](https://console.cloud.google.com/iam-admin/iam?project=lexical-devtools), choose **Grant access**, enter the person's Google account, and assign the **Owner** role.

### Marketplace access

Marketplace governance is shared between Meta and the [EPAM Open Source Office](https://www.epam.com/open-source).

An admin can invite any Google account to a Chrome publisher, so the request flow is: enable [2-Step Verification](https://support.google.com/accounts/answer/185839) on your Google account, then ping in the [Lexical Discord](https://discord.gg/KmG4wQnnD9) to ask to be added.

For Firefox, enable two-factor authentication, set a display name, then ping in the [Lexical Discord](https://discord.gg/KmG4wQnnD9) to ask to be added.

## Design

This extension follows typical [Browser DevTools architecture](https://developer.chrome.com/docs/extensions/how-to/devtools/extend-devtools) that includes sereral independent contexts that communicate via events or extension APIs.

<figure align="center">
  <img src="./docs/architecture-diagram.png" alt="DevTools extension architecture" width="526">
  <figcaption>DevTools extension architecture.</figcaption>
</figure>
