import type { BridgeData } from "@home-assistant-matter-hub/common";
import type { Environment } from "@matter/main";
import { BasicInformationServer } from "@matter/main/behaviors";
import { type Endpoint, ServerNode } from "@matter/main/node";
import { createBridgeServerConfig } from "../../utils/json/create-bridge-server-config.js";

export class BridgeServerNode extends ServerNode {
  constructor(
    env: Environment,
    bridgeData: BridgeData,
    aggregator: Endpoint,
    options?: { tcp?: { incoming: boolean; outgoing: boolean } },
  ) {
    const config = createBridgeServerConfig(bridgeData, options);
    super({
      ...config,
      environment: env,
      parts: [...(config.parts ?? []), aggregator],
    });
  }

  async factoryReset() {
    await this.cancel();
    await this.erase();
    await renewRootUniqueId(this);
  }
}

/**
 * Spec 11.1.5.19: UniqueID shall change on a factory reset. The config default
 * is the bridge id and survives erase(), so Alexa met a node it had already
 * deleted (#530). A value set here is persisted and outranks the default.
 */
export async function renewRootUniqueId(node: ServerNode) {
  await node.setStateOf(BasicInformationServer, {
    uniqueId: BasicInformationServer.createUniqueId(),
  });
}
