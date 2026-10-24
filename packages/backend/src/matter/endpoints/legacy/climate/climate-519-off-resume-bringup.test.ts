import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  HomeAssistantEntityRegistry,
  HomeAssistantEntityState,
} from "@home-assistant-matter-hub/common";
import { Environment, VariableService } from "@matter/general";
import { ControllerBehavior, VendorId } from "@matter/main";
import { Thermostat } from "@matter/main/clusters";
import { ServerNode } from "@matter/main/node";
import { Write } from "@matter/main/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeDataProvider } from "../../../../services/bridges/bridge-data-provider.js";
import { BridgeRegistry } from "../../../../services/bridges/bridge-registry.js";
import { EntityStateProvider } from "../../../../services/bridges/entity-state-provider.js";
import {
  type HomeAssistantAction,
  HomeAssistantActions,
} from "../../../../services/home-assistant/home-assistant-actions.js";
import { HomeAssistantConfig } from "../../../../services/home-assistant/home-assistant-config.js";
import type { HomeAssistantRegistry } from "../../../../services/home-assistant/home-assistant-registry.js";
import { AggregatorEndpoint } from "../../aggregator-endpoint.js";
import { LegacyEndpoint } from "../legacy-endpoint.js";

// #519: a setpoint write while the thermostat is Off must resume it. The
// heating path did, the cooling path only on cooling-only devices, so Alexa's
// cooling write on a heat+cool device was dropped. Auto-resume now also sets
// systemMode optimistically so controllers stop reading Off right away.

const DEVICE = "th-dev";
let CLIMATE = "climate.th";

let dir: string;
let env: Environment;
let counter = 0;
let server: ServerNode | undefined;
let controller: ServerNode | undefined;
let calls: HomeAssistantAction[] = [];

function registryEntity(entityId: string): HomeAssistantEntityRegistry {
  return {
    area_id: null,
    categories: {},
    device_id: DEVICE,
    disabled_by: null,
    entity_category: null,
    entity_id: entityId,
    has_entity_name: false,
    hidden_by: null,
    id: entityId,
    labels: [],
    name: null,
    original_name: entityId,
    platform: "test",
    translation_key: null,
    unique_id: entityId,
  } as unknown as HomeAssistantEntityRegistry;
}

function climateState(
  value: string,
  hvacModes: string[],
): HomeAssistantEntityState {
  const attributes: Record<string, unknown> = {
    friendly_name: "TH",
    hvac_modes: hvacModes,
    min_temp: 7,
    max_temp: 35,
    temperature: 21,
    current_temperature: 22,
    // TARGET_TEMPERATURE | TURN_OFF | TURN_ON
    supported_features: 385,
  };
  return {
    entity_id: CLIMATE,
    state: value,
    attributes,
    context: { id: "ctx" },
    last_changed: "2026-01-01T00:00:00",
    last_updated: "2026-01-01T00:00:00",
  };
}

function dataProvider(): BridgeDataProvider {
  return new BridgeDataProvider({
    id: "b",
    name: "b",
    port: 0,
    filter: { include: [], exclude: [], includeMode: "any" },
    basicInformation: {
      vendorId: 0xfff1,
      vendorName: "t",
      productName: "t",
      productLabel: "t",
      hardwareVersion: 1,
      softwareVersion: 1,
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
    } as any,
    // biome-ignore lint/suspicious/noExplicitAny: test fixture
  } as any);
}

function registry(value: string, hvacModes: string[]): BridgeRegistry {
  const states: Record<string, HomeAssistantEntityState> = {
    [CLIMATE]: climateState(value, hvacModes),
  };
  const haRegistry = {
    areas: new Map(),
    devices: { [DEVICE]: { id: DEVICE, name: "TH" } },
    entities: { [CLIMATE]: registryEntity(CLIMATE) },
    labels: [],
    states,
  } as unknown as HomeAssistantRegistry;
  return new BridgeRegistry(haRegistry, dataProvider());
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hamh-519climate-"));
  env = new Environment("test", Environment.default);
  env.get(VariableService).set("storage.path", dir);
  env.set(BridgeDataProvider, dataProvider());
  env.set(HomeAssistantConfig, {
    unitSystem: { temperature: "°C" },
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  calls = [];
  env.set(HomeAssistantActions, {
    call(action: HomeAssistantAction) {
      calls.push(action);
    },
    fireEvent() {},
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
  env.set(EntityStateProvider, {
    getState: () => undefined,
    getNumericState: () => null,
    getBatteryPercent: () => null,
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any);
});

afterEach(async () => {
  await controller?.close().catch(() => {});
  controller = undefined;
  await server?.close().catch(() => {});
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function mount(value: string, hvacModes: string[]) {
  CLIMATE = `climate.th${counter}`;
  const endpoint = await LegacyEndpoint.create(
    registry(value, hvacModes),
    CLIMATE,
  );
  expect(endpoint).toBeDefined();
  server = await ServerNode.create({
    // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
    environment: env as any,
    id: `519climate-node-${counter}`,
    network: { port: 0 },
    commissioning: { passcode: 20202021, discriminator: 3840 },
    basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8000 },
  });
  const aggregator = new AggregatorEndpoint("aggregator");
  await server.add(aggregator);
  await aggregator.add(endpoint!);
  await server.start();
  // biome-ignore lint/suspicious/noExplicitAny: runtime state
  const port = (server.state as any).network.operationalPort as number;

  controller = await ServerNode.create(
    ServerNode.RootEndpoint.with(ControllerBehavior),
    {
      // biome-ignore lint/suspicious/noExplicitAny: env valid at runtime
      environment: env as any,
      id: `519climate-controller-${counter++}`,
      network: { port: 0 },
      basicInformation: { vendorId: VendorId(0xfff1), productId: 0x8001 },
    },
  );
  await controller.start();
  const client = await controller.peers.forDescriptor({
    addresses: [{ type: "udp", ip: "127.0.0.1", port }],
    deviceIdentifier: `519-${counter}`,
    D: 3840,
    CM: 1,
    // biome-ignore lint/suspicious/noExplicitAny: matter.js client API is loosely typed
  } as any);
  await client.commission({
    passcode: 20202021,
    discriminator: 3840,
    autoSubscribe: false,
    autoStateInitialize: false,
  });
  return { endpoint: endpoint!, client };
}

async function remoteWrite(
  // biome-ignore lint/suspicious/noExplicitAny: matter.js client API is loosely typed
  client: any,
  endpointNo: number,
  attrs: Record<string, number>,
) {
  await client.interaction.write(
    Write(
      ...Object.entries(attrs).map(([name, value]) =>
        Write.Attribute({
          endpoint: endpointNo,
          cluster: Thermostat,
          attributes: name,
          value,
          // biome-ignore lint/suspicious/noExplicitAny: matter.js client API is loosely typed
        } as any),
      ),
    ),
  );
}

const modeCalls = () =>
  calls.filter((c) => c.action === "climate.set_hvac_mode");
const tempCalls = () =>
  calls.filter((c) => c.action === "climate.set_temperature");

describe("thermostat off auto-resume (#519)", () => {
  it("resumes Cool from a cooling write while Off on a heat+cool device", async () => {
    const { endpoint, client } = await mount("off", [
      "off",
      "heat",
      "cool",
      "heat_cool",
    ]);
    calls = [];
    await remoteWrite(client, endpoint.number, {
      occupiedCoolingSetpoint: 2000,
    });
    expect(modeCalls()).toHaveLength(1);
    // biome-ignore lint/suspicious/noExplicitAny: action payload
    expect((modeCalls()[0].data as any).hvac_mode).toBe("cool");
    expect(tempCalls()).toHaveLength(1);
    // Mode goes to HA before the temperature (#269 ordering).
    expect(calls.indexOf(modeCalls()[0])).toBeLessThan(
      calls.indexOf(tempCalls()[0]),
    );
    // Optimistic: controllers must not keep reading Off until HA confirms.
    // biome-ignore lint/suspicious/noExplicitAny: read cluster state
    expect((endpoint.state as any).thermostat.systemMode).toBe(
      Thermostat.SystemMode.Cool,
    );
  });

  it("resumes exactly once when both setpoints arrive in one write", async () => {
    const { endpoint, client } = await mount("off", [
      "off",
      "heat",
      "cool",
      "heat_cool",
    ]);
    calls = [];
    // First attribute in the write picks the mode (pinned rule): heating
    // listed first resumes Heat, the cooling handler sees non-Off and skips.
    await remoteWrite(client, endpoint.number, {
      occupiedHeatingSetpoint: 2100,
      occupiedCoolingSetpoint: 2400,
    });
    expect(modeCalls()).toHaveLength(1);
    // biome-ignore lint/suspicious/noExplicitAny: action payload
    expect((modeCalls()[0].data as any).hvac_mode).toBe("heat");
    // biome-ignore lint/suspicious/noExplicitAny: read cluster state
    expect((endpoint.state as any).thermostat.systemMode).toBe(
      Thermostat.SystemMode.Heat,
    );
  });

  it("a cooling-first combined write resumes Cool", async () => {
    const { endpoint, client } = await mount("off", [
      "off",
      "heat",
      "cool",
      "heat_cool",
    ]);
    calls = [];
    await remoteWrite(client, endpoint.number, {
      occupiedCoolingSetpoint: 2400,
      occupiedHeatingSetpoint: 2100,
    });
    expect(modeCalls()).toHaveLength(1);
    // biome-ignore lint/suspicious/noExplicitAny: action payload
    expect((modeCalls()[0].data as any).hvac_mode).toBe("cool");
    // biome-ignore lint/suspicious/noExplicitAny: read cluster state
    expect((endpoint.state as any).thermostat.systemMode).toBe(
      Thermostat.SystemMode.Cool,
    );
  });

  it("maps the resume to heat_cool on a heat_cool-only zone", async () => {
    const { endpoint, client } = await mount("off", ["off", "heat_cool"]);
    calls = [];
    // Zone CSO is HeatingOnly without an hvac_action, so the cooling write
    // must flip to Heat instead of tripping matter.js's ConstraintError.
    await remoteWrite(client, endpoint.number, {
      occupiedCoolingSetpoint: 2000,
    });
    expect(modeCalls()).toHaveLength(1);
    // biome-ignore lint/suspicious/noExplicitAny: action payload
    expect((modeCalls()[0].data as any).hvac_mode).toBe("heat_cool");
    // biome-ignore lint/suspicious/noExplicitAny: read cluster state
    expect((endpoint.state as any).thermostat.systemMode).toBe(
      Thermostat.SystemMode.Heat,
    );
  });

  it("keeps the heat-only resume unchanged", async () => {
    const { endpoint, client } = await mount("off", ["off", "heat"]);
    calls = [];
    await remoteWrite(client, endpoint.number, {
      occupiedHeatingSetpoint: 2100,
    });
    expect(modeCalls()).toHaveLength(1);
    // biome-ignore lint/suspicious/noExplicitAny: action payload
    expect((modeCalls()[0].data as any).hvac_mode).toBe("heat");
    expect(tempCalls()).toHaveLength(1);
    // biome-ignore lint/suspicious/noExplicitAny: read cluster state
    expect((endpoint.state as any).thermostat.systemMode).toBe(
      Thermostat.SystemMode.Heat,
    );
  });
});
