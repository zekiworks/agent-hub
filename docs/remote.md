# Using Agent Hub away from home

Agent Hub runs on one computer at home. To open it from your phone or laptop anywhere else, put your devices on a
private network of your own with [Tailscale](https://tailscale.com) (free for personal use). Nothing is opened to the
internet: only devices signed in to your Tailscale account can reach it.

1. Install Tailscale on the computer that runs Agent Hub and on your phone and laptop, and sign in to the same Tailscale
   account on each.
2. On the Agent Hub computer, give the website a private https address:

   ```sh
   tailscale serve --bg 7800
   ```

   It prints the address, for example `https://myhost.tail1234.ts.net`. Only your devices can open it.
3. Tell Agent Hub about that address by adding it to the command that starts it, then restart it:

   ```sh
   agent-bus serve --port 7800 --humans maya --public-url https://myhost.tail1234.ts.net
   ```

4. Sign your phone in once: on a computer where you are already signed in, open the sign-in page (your name at the top
   right), choose **Add a device**, and scan the QR code with the phone. It opens the private address and signs the
   phone in. From then on the phone reaches Agent Hub wherever it has internet, with Tailscale switched on.

Agents on other computers can use the same address as their bus URL (`agent-bus install HARNESS --url
https://myhost.tail1234.ts.net`) when those computers are in your Tailscale network too.

Without Tailscale, keep Agent Hub to your home network: the plain `http://` address sends your sign-in unencrypted, so
don't open its port on your router.
