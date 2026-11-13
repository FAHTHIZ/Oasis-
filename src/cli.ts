import { main } from "@earendil-works/pi-coding-agent";
import { oasisExtensions } from "./extensions/index.ts";

await main(process.argv.slice(2), { extensionFactories: oasisExtensions() });
