import { useEffect, type MutableRefObject } from "react";
import type { Application } from "pixi.js";
import { Container, Graphics, Text } from "pixi.js";
import type { ServerAllocation, ServerNode } from "../../types";

export function useServerLayer(
  servers: ServerNode[],
  serverAllocations: ServerAllocation[],
  loading: boolean,
  appRef: MutableRefObject<Application | null>,
  worldRef: MutableRefObject<Container | null>,
  serverSpritesRef: MutableRefObject<Map<string, Container>>,
  serverSlotsRef: MutableRefObject<Array<{ x: number; y: number; name: string }>>,
) {
  useEffect(() => {
    if (!appRef.current || loading) return;
    const world = worldRef.current;
    if (!world) return;

    const slots = serverSlotsRef.current;
    if (slots.length === 0) return;
    const activeByServer = new Map<string, ServerAllocation>();
    for (const allocation of serverAllocations) {
      if (allocation.status !== "active" || !allocation.server_id) continue;
      if (!activeByServer.has(allocation.server_id)) activeByServer.set(allocation.server_id, allocation);
    }
    const statusColor = (status: ServerNode["status"]) => {
      if (status === "online") return 0x4ade80;
      if (status === "busy") return 0xf59e0b;
      if (status === "idle") return 0x22d3ee;
      return 0x64748b;
    };

    servers.forEach((server, index) => {
      const slot = slots[index % slots.length];
      const active = activeByServer.get(server.id);
      const existing = serverSpritesRef.current.get(server.id);
      if (existing) {
        existing.x = slot.x;
        existing.y = slot.y;
        const nameText = existing.getChildByLabel("name") as Text | null;
        if (nameText) nameText.text = server.name.toUpperCase().slice(0, 12);
        const bindText = existing.getChildByLabel("bind") as Text | null;
        if (bindText) bindText.text = active?.agent_name ? active.agent_name.toUpperCase().slice(0, 10) : "IDLE";
        const indicator = existing.getChildByLabel("indicator") as Graphics | null;
        if (indicator) indicator.clear().circle(0, 0, 2.5).fill(statusColor(server.status));
        return;
      }

      const cont = new Container();
      cont.label = server.id;
      cont.x = slot.x;
      cont.y = slot.y;

      const frame = new Graphics();
      frame.roundRect(-10, -22, 20, 24, 3).fill({ color: 0x0f172a, alpha: 0.9 });
      frame.roundRect(-10, -22, 20, 24, 3).stroke({ color: 0x64748b, width: 1, alpha: 0.9 });
      cont.addChild(frame);

      const led = new Graphics();
      led.label = "indicator";
      led.circle(0, 0, 2.5).fill(statusColor(server.status));
      led.x = 0;
      led.y = -18;
      cont.addChild(led);

      const name = new Text({
        text: server.name.toUpperCase().slice(0, 12),
        style: {
          fontFamily: '"Upheaval TT BRK", "Press Start 2P", monospace',
          fontSize: 12,
          fill: 0xe2e8f0,
        },
      });
      name.label = "name";
      name.anchor.set(0.5, 0);
      name.y = -10;
      cont.addChild(name);

      const bind = new Text({
        text: active?.agent_name ? active.agent_name.toUpperCase().slice(0, 10) : "IDLE",
        style: {
          fontFamily: '"Upheaval TT BRK", "Press Start 2P", monospace',
          fontSize: 10,
          fill: 0x93c5fd,
        },
      });
      bind.label = "bind";
      bind.anchor.set(0.5, 0);
      bind.y = -2;
      cont.addChild(bind);

      world.addChild(cont);
      serverSpritesRef.current.set(server.id, cont);
    });

    serverSpritesRef.current.forEach((sprite, id) => {
      if (servers.some((server) => server.id === id)) return;
      world.removeChild(sprite);
      serverSpritesRef.current.delete(id);
    });
  }, [loading, serverAllocations, servers, appRef, worldRef, serverSpritesRef, serverSlotsRef]);
}
