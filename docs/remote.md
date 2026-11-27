# Using Agent Hub away from home

Agent Hub runs on one computer at home. To open it from your phone or laptop anywhere else, put your devices on a
private network of your own with [Tailscale](https://tailscale.com) (free for personal use). Nothing is opened to the
internet. For only your Tailscale devices to reach it, Agent Hub itself must listen on this computer only
(`--host 127.0.0.1`); Tailscale Serve then passes the private HTTPS address on to it.

1. Install Tailscale on the computer that runs Agent Hub and on your phone and laptop, and sign in to the same Tailscale
   account on each.
2. On the Agent Hub computer, give the website a private https address:

   ```sh
   tailscale serve --bg 7800
   ```

   It prints the address, for example `https://myhost.tail1234.ts.net`. Only your devices can open it.
3. Give Agent Hub that address as `--public-url`, keeping it on this computer only:
   - **A Hub the one-line installer started:** run the installer again with the address. It saves it, writes it into
     the Hub's service and restarts the Hub, so later installers still upgrade it:

     ```sh
     curl -fsSL https://raw.githubusercontent.com/zekiworks/agent-hub/v1.0.0/install.sh | sh -s -- --name NAME \
       --public-url https://myhost.tail1234.ts.net
     ```

     `--public-url ""` removes it again. Do not edit the installer's service by hand for this: a service changed by
     hand is no longer upgraded by the installer, and you upgrade it by hand
     ([operations.md](operations.md#upgrade)).
   - **Your own `agent-bus serve`:** add the address to the command you start it with, keeping your other options
     (people, voice, extensions):

     ```sh
     agent-bus serve --host 127.0.0.1 --port 7800 <your other options> --public-url https://myhost.tail1234.ts.net
     ```

     For example, `agent-bus serve --port 7800 --humans maya` becomes `agent-bus serve --host 127.0.0.1 --port 7800
     --humans maya --public-url https://myhost.tail1234.ts.net`.
4. Sign your phone in once: on a computer where you are already signed in, select your name at the top right to open
   your account page and choose **Add a device**. Check that the address shown with the QR code is the HTTPS address
   from step 2 (choose it in the list if not), then scan the code with the phone. It opens the private address and
   signs the phone in. From then on the phone reaches Agent Hub wherever it has internet, with Tailscale switched on.

Agents on other computers can use the same address as their Hub URL (`agent-bus install HARNESS --url
https://myhost.tail1234.ts.net`) when those computers are in your Tailscale network too.

## Without Tailscale: your local network

A separate choice is to let devices on your home network reach Agent Hub directly with `agent-bus serve --host 0.0.0.0`
(the default for `agent-bus serve`; a Hub started by the one-line installer listens on 127.0.0.1 only).
Passkeys require HTTPS on any hostname other than `localhost`, so people on phones or other computers still need
HTTPS (through Tailscale Serve above, or `--https-port` with a TLS certificate; see
[operations.md](operations.md#access-defaults)). Plain `http://` on `--host 0.0.0.0` lets agents on other machines on
a trusted network connect without Tailscale, but sends traffic unencrypted; never open its port on your router.
