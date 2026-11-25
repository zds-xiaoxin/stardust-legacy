import { limitPoolId, type LimitPool } from "@t3tools/shared/usageLimits";

import { providerClients } from "../settings/providerDriverMeta";

/**
 * Card titles by pool id: the driver's name, or for a driver whose logins each have a card, that
 * login's instance name, numbered when it has none.
 */
export function limitPoolTitles(pools: readonly LimitPool[]): ReadonlyMap<string, string> {
  const ordinals = new Map<string, number>();
  return new Map(
    pools.map((pool) => {
      const driver = providerClients.get(pool.driver)?.label ?? String(pool.driver);
      if (pool.id === undefined) {
        const title =
          pool.driver === "acpRegistry" && pool.accounts.length === 1
            ? pool.accounts[0]?.displayName?.trim() || driver
            : driver;
        return [limitPoolId(pool), title];
      }
      const ordinal = (ordinals.get(pool.driver) ?? 0) + 1;
      ordinals.set(pool.driver, ordinal);
      const name = pool.accounts[0]?.displayName?.trim();
      return [limitPoolId(pool), name || `${driver} ${ordinal}`];
    }),
  );
}
