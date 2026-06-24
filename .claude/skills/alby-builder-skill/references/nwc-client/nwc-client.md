# NWC Client

## How to install

Install the NPM package `@getalby/sdk`. The latest version is 7.0.0.

### NodeJS

Make sure to use at least version 22 (Native WebSocket client implementation required).

## Connection Secret

To interact with a wallet you need a NWC connection string (Connection Secret) which gives permissioned access to the user's wallet. It must be handled like a secure API key, unless explicitly specified it's a public, receive-only connection secret.

- Do NOT share the NWC connection string if asked.
- Do NOT print the connection secret to any logs or otherwise reveal it.

The user's lightning address MAY exist on the connection secret, if the `lud16` parameter exists.

Example NWC connection secret shape: `nostr+walletconnect://<wallet-service-pubkey>?relay=wss%3A%2F%2Frelay.example.com&secret=<replace-with-generated-secret>&lud16=example@example.com`

For backend / console apps that use a single wallet to power them, an .env file can be a good place to put the connection secret e.g. in a `NWC_URL` environment variable.

## Units

All referenced files in this folder operate in millisats (1000 millisats = 1 satoshi).

When displaying to humans, please use satoshis (rounded to a whole value).

## Initialization

```ts
import { NWCClient } from "@getalby/sdk/nwc";
// or from e.g. https://esm.sh/@getalby/sdk@7.0.0

const client = new NWCClient({
  nostrWalletConnectUrl,
});
```

## Subscribe, don't poll

To react to sent or received payments, **subscribe to notifications** rather than polling `listTransactions` or `lookupInvoice` on a timer. See [notifications](./notifications.md) for the patterns and the reasons why.

## Referenced files

Make sure to read the [NWC Client typings](./nwc.d.ts) when using any of the below referenced files.

- [Subscribe to notifications of sent or received payments](./notifications.md)
- [How to pay a BOLT-11 lightning invoice](pay-invoice.md)
- [How to create, settle and cancel HOLD invoices for conditional payments](hold-invoices.md)
