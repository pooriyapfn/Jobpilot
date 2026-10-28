import { z } from "zod";

// Every schema that crosses the engine ↔ app boundary is registered under an id.
// The id becomes its JSON Schema file name and its Swift type name.
export const registry = z.registry<{ id: string }>();

export const def = <T extends z.ZodType>(id: string, schema: T): T => {
  registry.add(schema, { id });
  return schema;
};
