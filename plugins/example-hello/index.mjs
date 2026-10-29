// Plugin d'exemple. Aucune permission : il n'utilise que le stockage qui lui est propre.
export default {
  on: {
    "agent.cycle": async (ctx) => {
      const n = Number((await ctx.storage.get("cycles")) ?? 0) + 1;
      await ctx.storage.set("cycles", String(n));
    },
  },
  tools: {
    hello: async (ctx, args) => {
      const cycles = (await ctx.storage.get("cycles")) ?? "0";
      return `Bonjour ${String(args.name ?? "inconnu").slice(0, 50)} ! L'agent a tourné ${cycles} fois depuis mon installation.`;
    },
  },
};
