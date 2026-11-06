import type { Context } from "hono";
import { wrapTime } from "hono/timing";

import type { AppEnv } from "./types.ts";

/**
 * Mide una operación asíncrona y la deja en el header `Server-Timing` de la respuesta
 * (middleware `timing()` de Hono, montado en app.ts). Así se separa, desde el cliente,
 * cuánto de una lectura es red y cuánto es el Worker o R2.
 */
export type Timer = <T>(name: string, run: () => Promise<T>) => Promise<T>;

export function timer(c: Context<AppEnv>): Timer {
  return (name, run) => wrapTime(c, name, run());
}

/** Para código que no tiene contexto (pruebas, consultas en lote): no mide nada. */
export const untimed: Timer = (_name, run) => run();
