import { Layer } from "effect";

import { Blockers, BlockersMemory } from "./blocker.ts";
import { Interactions, makeInteractions } from "./interactions.ts";
import { Questionnaires, QuestionnairesMemory } from "./questionnaires.ts";

export type InteractionServices = Blockers | Interactions | Questionnaires;

export const InteractionsLayer: Layer.Layer<InteractionServices> =
  Layer.mergeAll(
    Layer.effect(Blockers)(BlockersMemory),
    Layer.sync(Interactions)(makeInteractions),
    Layer.effect(Questionnaires)(QuestionnairesMemory)
  );
