import type { SlackRuntime } from "./index.ts";

import { globalSlot } from "./global-slot.ts";

export const slackRuntime = globalSlot<SlackRuntime>("ori.slack.runtime");
