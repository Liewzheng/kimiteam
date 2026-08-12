/**
 * Scenario: LLM requester uses bounded recovery projections after a
 * deterministic provider rejection — strict projection for tool-use
 * adjacency, degraded media followed by full stripping for body-size 413s,
 * and media stripping for image-format rejections.
 *
 * Responsibilities: assert retry eligibility, projection order and bounds,
 * per-turn recovery stickiness, request recording, and usage accounting.
 * Wiring: real AgentLLMRequesterService with stubbed context memory,
 * projector, context sizing, profile, model, telemetry, and wire/log services. Run:
 * pnpm test -- test/agent/llmRequester/llmRequesterService.test.ts
 */

import { createControlledPromise } from '@antfu/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import {
  IAgentContextProjectorService,
  type MediaStripSnapshot,
} from '#/agent/contextProjector/contextProjector';
import { AgentContextProjectorService } from '#/agent/contextProjector/contextProjectorService';
import { AgentLLMRequesterService } from '#/agent/llmRequester/llmRequesterService';
import { IAgentLLMRequesterService } from '#/agent/llmRequester/llmRequester';
import { IAgentTokenCountingService } from '#/agent/tokenCounting/tokenCounting';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentToolSelectService } from '#/agent/toolSelect/toolSelect';
import { IAgentVideoResolverService } from '#/agent/media/videoResolver';
import { IAgentUsageService } from '#/agent/usage/usage';
import { IConfigService } from '#/app/config/config';
import { type DomainEvent, IEventBus } from '#/app/event/eventBus';
import {
  APIConnectionError,
  APIEmptyResponseError,
  APIRequestTooLargeError,
  APIStatusError,
} from '#/kosong/contract/errors';
import { emptyUsage, type TokenUsage } from '#/kosong/contract/usage';
import type { Message } from '#/kosong/contract/message';
import type { ThinkingEffort } from '#/kosong/contract/provider';
import {
  UNKNOWN_CAPABILITY,
  type ModelCapability,
} from '#/kosong/contract/capability';
import { IModelCatalog, type Model } from '#/kosong/model/catalog';
import { IModelService } from '#/kosong/model/model';
import {
  type ModelRequestEvent,
  type ModelRequestInput,
  type ModelRequester,
} from '#/kosong/model/modelRequester';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ILogService } from '#/_base/log/log';
import { Error2, ErrorCodes } from '#/errors';
import { IWireService } from '#/wire/wire';
import type { WireRecord } from '#/wire/record';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';

import { recordingWireLog, registerTestAgentWire } from '../../wire/stubs';

// Shared full-capability model for the error-recovery chains: every media
// modality is supported, so the capability media gate leaves them on the
// normal projection and the recovery paths stay reachable.
const capabilities: ModelCapability = {
  image_in: true,
  video_in: true,
  audio_in: true,
  thinking: false,
  tool_use: false,
  max_context_tokens: 1000,
};

const history: Message[] = [
  { role: 'user', content: [{ type: 'text', text: 'hello' }], toolCalls: [] },
];

function createRequester(
  calls: { value: number },
  firstCallError?: Error | null,
  subsequentCallErrors: readonly Error[] = [],
  capturedInputs?: ModelRequestInput[],
  modelCapabilities: ModelCapability = capabilities,
): ModelRequester {
  const model: Model = {
    id: 'm',
    name: 'wire-model',
    aliases: [],
    protocol: 'anthropic',
    baseUrl: 'https://example.test',
    headers: {},
    capabilities: modelCapabilities,
    maxContextSize: 1000,
    alwaysThinking: false,
    providerName: 'p',
    authProvider: { getAuth: async () => undefined },
  };
  return {
    model,
    request: async function* (input) {
      calls.value += 1;
      capturedInputs?.push(input);
      const error =
        calls.value === 1
          ? firstCallError === null
            ? undefined
            : (firstCallError ??
              new APIStatusError(400, 'messages: `tool_use` ids must be unique'))
          : subsequentCallErrors[calls.value - 2];
      if (error !== undefined) throw error;
      yield {
        type: 'finish',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], toolCalls: [] },
        providerFinishReason: 'completed',
        rawFinishReason: 'stop',
        id: 'resp-1',
      };
    },
  };
}

let disposables: DisposableStore;

beforeEach(() => {
  disposables = new DisposableStore();
});

afterEach(() => disposables.dispose());

function createService(
  requester: ModelRequester,
  projector:
    | (Pick<IAgentContextProjectorService, 'project' | 'projectStrict'> &
        Partial<
          Pick<
            IAgentContextProjectorService,
            | 'captureMediaStripSnapshot'
            | 'projectMediaDegraded'
            | 'projectMediaStripped'
          >
        >)
    | undefined,
  options: {
    readonly thinkingLevel?: ThinkingEffort;
    /** Context-memory history returned by the stubbed `IAgentContextMemoryService.get()`. */
    readonly history?: Message[];
  } = {},
) {
  const ix = disposables.add(new TestInstantiationService());
  const thinkingLevel = options.thinkingLevel ?? 'off';
  const profile: Partial<IAgentProfileService> = {
    resolveModelContext: () => ({
      modelAlias: 'm',
      modelCapabilities: capabilities,
      maxOutputSize: undefined,
      alwaysThinking: undefined,
      thinkingLevel,
      reservedContextSize: undefined,
      compactionTriggerRatio: undefined,
    }),
    resolveRequestParams: () => ({}),
    getSystemPrompt: () => 'system',
    data: () => ({
      cwd: '',
      modelAlias: 'm',
      modelCapabilities: capabilities,
      thinkingLevel,
      systemPrompt: 'system',
    }),
  };
  const measuredCalls: { readonly messages: number; readonly usage: TokenUsage }[] = [];
  const tokenCounting = {
    get: () => ({ size: 0, measured: 0, estimated: 0 }),
    measured: (input: readonly Message[], _output: readonly Message[], usage: TokenUsage) => {
      measuredCalls.push({ messages: input.length, usage });
    },
  };
  const usage = { record: () => undefined, status: () => ({}) };
  const context = { get: () => options.history ?? history };
  const tools = { list: () => [] };
  const config: Partial<IConfigService> = {
    get: (() => undefined) as IConfigService['get'],
  };
  const log = { info: () => undefined, warn: () => undefined };
  const telemetryRecords: TelemetryRecord[] = [];
  const telemetry = recordingTelemetry(telemetryRecords);
  const toolSelect: Partial<IAgentToolSelectService> = {
    enabled: () => false,
    shapeTools: (entries) => entries,
    shapeHistory: (messages) => messages,
  };
  const testSnapshot = Object.freeze({}) as MediaStripSnapshot;
  const events: DomainEvent[] = [];
  const eventBus: IEventBus = {
    _serviceBrand: undefined,
    publish: (event) => events.push(event),
    subscribe: () => toDisposable(() => {}),
  };

  ix.stub(IAgentContextMemoryService, context);
  ix.stub(IAgentToolSelectService, toolSelect);
  ix.stub(IAgentVideoResolverService, { resolve: async (messages) => messages });
  if (projector === undefined) {
    ix.set(
      IAgentContextProjectorService,
      new SyncDescriptor(AgentContextProjectorService),
    );
  } else {
    ix.stub(IAgentContextProjectorService, {
      captureMediaStripSnapshot: () => testSnapshot,
      projectMediaDegraded: projector.project,
      projectMediaStripped: projector.project,
      ...projector,
    });
  }
  ix.stub(IAgentTokenCountingService, tokenCounting);
  ix.stub(IAgentToolRegistryService, tools);
  ix.stub(IAgentProfileService, profile);
  ix.stub(IAgentUsageService, usage);
  ix.stub(IConfigService, config);
  ix.stub(ILogService, log);
  ix.stub(ITelemetryService, telemetry);
  ix.stub(IModelCatalog, {
    _serviceBrand: undefined,
    get: () => requester.model,
    getRequester: () => requester,
    findByName: () => [],
  });
  ix.stub(IModelService, {
    get: () => undefined,
  });
  const records: WireRecord[] = [];
  registerTestAgentWire(ix, 'wire/llm-requester', {
    log: recordingWireLog(records),
    eventBus,
  });
  ix.set(IAgentStateService, new AgentStateService());
  ix.set(IAgentLLMRequesterService, new SyncDescriptor(AgentLLMRequesterService));

  return {
    service: ix.get(IAgentLLMRequesterService),
    wire: ix.get(IWireService),
    records,
    events,
    telemetryRecords,
    measuredCalls,
  };
}

describe('AgentLLMRequesterService measured anchors', () => {
  it('skips the measured anchor when the stream reports no usage', async () => {
    const { service, measuredCalls } = createService(createRequester({ value: 0 }), undefined);

    await service.request();

    expect(measuredCalls).toHaveLength(0);
  });

  it('writes the measured anchor from the reported usage', async () => {
    const requester = createRequester({ value: 0 });
    const base = requester.request.bind(requester);
    requester.request = async function* (input, signal, options) {
      yield {
        type: 'usage',
        usage: { inputOther: 40, output: 2, inputCacheRead: 0, inputCacheCreation: 0 },
        model: 'wire-model',
      };
      yield* base(input, signal, options);
    };
    const { service, measuredCalls } = createService(requester, undefined);

    await service.request();

    expect(measuredCalls).toHaveLength(1);
    expect(measuredCalls[0]?.usage.inputOther).toBe(40);
  });
});

describe('AgentLLMRequesterService Anthropic effort diagnostics', () => {
  it('warns and sends when the effort is not listed by the model', async () => {
    const calls = { value: 0 };
    const requester = createRequester(calls, null);
    Object.defineProperty(requester.model, 'supportEfforts', { value: ['max'] });
    const { service, events } = createService(requester, undefined, { thinkingLevel: 'high' });

    const result = await service.request();

    expect(result.message.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(calls.value).toBe(1);
    expect(events.filter((event) => event.type === 'warning')).toEqual([
      {
        type: 'warning',
        code: 'anthropic-thinking-effort-not-listed',
        message:
          'Thinking effort "high" is not listed for model "wire-model" (known: max). The configured value will be sent unchanged to the Anthropic-compatible backend.',
      },
    ]);
  });
});

describe('AgentLLMRequesterService strict resend', () => {
  it('resends once with strict projection after a recoverable structural 400', async () => {
    const calls = { value: 0 };
    let projectCalls = 0;
    let strictCalls = 0;
    const { service } = createService(createRequester(calls), {
      project: (messages: readonly ContextMessage[]) => {
        projectCalls += 1;
        return messages;
      },
      projectStrict: (messages: readonly ContextMessage[]) => {
        strictCalls += 1;
        return messages;
      },
    });

    const result = await service.request();

    expect(result.message.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(result.usage).toEqual(emptyUsage());
    expect(calls.value).toBe(2);
    expect(projectCalls).toBe(1);
    expect(strictCalls).toBe(1);
  });

  it('does not resend for non-recoverable errors', async () => {
    const requester = createRequester({ value: 0 });
    Object.defineProperty(requester, 'request', {
      value: async function* () {
        const events: ModelRequestEvent[] = [];
        for (const event of events) yield event;
        throw new APIStatusError(401, 'unauthorized');
      },
    });
    let strictCalls = 0;
    const { service } = createService(requester, {
      project: (messages: readonly ContextMessage[]) => messages,
      projectStrict: (messages: readonly ContextMessage[]) => {
        strictCalls += 1;
        return messages;
      },
    });

    await expect(service.request()).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(strictCalls).toBe(0);
  });
});

describe('AgentLLMRequesterService media-stripped resend', () => {
  const IMAGE_FORMAT_400 = new APIStatusError(
    400,
    'unsupported image format: image/avif is not supported',
  );

  it('resends once with the media-stripped projection after an image-format 400', async () => {
    const calls = { value: 0 };
    let projectCalls = 0;
    let strictCalls = 0;
    let strippedCalls = 0;
    const { service } = createService(createRequester(calls, IMAGE_FORMAT_400), {
      project: (messages: readonly ContextMessage[]) => {
        projectCalls += 1;
        return messages;
      },
      projectStrict: (messages: readonly ContextMessage[]) => {
        strictCalls += 1;
        return messages;
      },
      projectMediaStripped: (messages: readonly ContextMessage[]) => {
        strippedCalls += 1;
        return messages;
      },
    });

    const result = await service.request();

    expect(result.message.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(calls.value).toBe(2);
    expect(projectCalls).toBe(1);
    expect(strictCalls).toBe(0);
    expect(strippedCalls).toBe(1);
  });

  it('keeps later steps of the same turn on the stripped projection', async () => {
    const calls = { value: 0 };
    let projectCalls = 0;
    let strippedCalls = 0;
    const { service } = createService(createRequester(calls, IMAGE_FORMAT_400), {
      project: (messages: readonly ContextMessage[]) => {
        projectCalls += 1;
        return messages;
      },
      projectStrict: (messages: readonly ContextMessage[]) => messages,
      projectMediaStripped: (messages: readonly ContextMessage[]) => {
        strippedCalls += 1;
        return messages;
      },
    });

    await service.request({ source: { type: 'turn', turnId: 1, step: 1 } });
    expect(calls.value).toBe(2);
    expect(projectCalls).toBe(1);
    expect(strippedCalls).toBe(1);

    await service.request({ source: { type: 'turn', turnId: 1, step: 2 } });
    expect(calls.value).toBe(3);
    expect(projectCalls).toBe(1);
    expect(strippedCalls).toBe(2);
  });

  it('does not resend for an unrelated 400', async () => {
    const calls = { value: 0 };
    let strippedCalls = 0;
    const { service } = createService(
      createRequester(calls, new APIStatusError(400, 'some other validation problem')),
      {
        project: (messages: readonly ContextMessage[]) => messages,
        projectStrict: (messages: readonly ContextMessage[]) => messages,
        projectMediaStripped: (messages: readonly ContextMessage[]) => {
          strippedCalls += 1;
          return messages;
        },
      },
    );

    await expect(service.request()).rejects.toMatchObject({ statusCode: 400 });
    expect(calls.value).toBe(1);
    expect(strippedCalls).toBe(0);
  });
});

describe('AgentLLMRequesterService capability media gate', () => {
  const NO_VISION_CAPABILITIES: ModelCapability = {
    image_in: false,
    video_in: false,
    audio_in: false,
    thinking: true,
    tool_use: true,
    max_context_tokens: 64_000,
  };
  const VISION_NO_VIDEO_CAPABILITIES: ModelCapability = {
    image_in: true,
    video_in: false,
    audio_in: false,
    thinking: true,
    tool_use: true,
    max_context_tokens: 64_000,
  };
  const VISION_CAPABILITIES: ModelCapability = {
    image_in: true,
    video_in: true,
    audio_in: true,
    thinking: true,
    tool_use: true,
    max_context_tokens: 64_000,
  };
  const VISION_NO_AUDIO_CAPABILITIES: ModelCapability = {
    image_in: true,
    video_in: true,
    audio_in: false,
    thinking: true,
    tool_use: true,
    max_context_tokens: 64_000,
  };
  const AUDIO_URL = 'data:audio/mp3;base64,AU';
  const IMAGE_URL = 'data:image/png;base64,SWEET';
  const VIDEO_URL = 'data:video/mp4;base64,VID';

  function mediaProjectionCounter() {
    const counters = { projectCalls: 0, strippedCalls: 0 };
    return {
      counters,
      projector: {
        project: (messages: readonly ContextMessage[]) => {
          counters.projectCalls += 1;
          return messages;
        },
        projectStrict: (messages: readonly ContextMessage[]) => messages,
        projectMediaStripped: (messages: readonly ContextMessage[]) => {
          counters.strippedCalls += 1;
          return messages;
        },
      },
    };
  }

  it('starts on the media-stripped projection for a model without image or video input', async () => {
    const calls = { value: 0 };
    const { counters, projector } = mediaProjectionCounter();
    const { service, wire, records } = createService(
      createRequester(calls, null, [], undefined, NO_VISION_CAPABILITIES),
      projector,
    );

    const result = await service.request();

    expect(result.message.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(calls.value).toBe(1);
    expect(counters.projectCalls).toBe(0);
    expect(counters.strippedCalls).toBe(1);
    await wire.flush();
    expect(
      records
        .filter((record) => record.type === 'llm.request')
        .map((record) => record['projection']),
    ).toEqual(['media-stripped']);
  });

  it('keeps later steps of the same turn on the capability-stripped projection', async () => {
    const calls = { value: 0 };
    const { counters, projector } = mediaProjectionCounter();
    const { service } = createService(
      createRequester(calls, null, [], undefined, NO_VISION_CAPABILITIES),
      projector,
    );

    await service.request({ source: { type: 'turn', turnId: 1, step: 1 } });
    await service.request({ source: { type: 'turn', turnId: 1, step: 2 } });

    expect(calls.value).toBe(2);
    expect(counters.projectCalls).toBe(0);
    expect(counters.strippedCalls).toBe(2);
  });

  it('starts on the media-stripped projection for a vision model without video input', async () => {
    const calls = { value: 0 };
    const { counters, projector } = mediaProjectionCounter();
    const { service } = createService(
      createRequester(calls, null, [], undefined, VISION_NO_VIDEO_CAPABILITIES),
      projector,
    );

    const result = await service.request();

    expect(result.message.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(calls.value).toBe(1);
    expect(counters.projectCalls).toBe(0);
    expect(counters.strippedCalls).toBe(1);
  });

  it('keeps the normal projection when capabilities are unknown', async () => {
    const calls = { value: 0 };
    const { counters, projector } = mediaProjectionCounter();
    const { service } = createService(
      createRequester(calls, null, [], undefined, UNKNOWN_CAPABILITY),
      projector,
    );

    await service.request();

    expect(calls.value).toBe(1);
    expect(counters.projectCalls).toBe(1);
    expect(counters.strippedCalls).toBe(0);
  });

  it('recomputes per step when the model switches no-vision → vision → no-vision, keeping context memory intact', async () => {
    // Context memory holds a text+image user message; the gate must only
    // project it (read-side), never write back or mutate the stored history.
    const imageHistory: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image_url', imageUrl: { url: IMAGE_URL, id: 'img-1' } },
        ],
        toolCalls: [],
      },
    ];
    const storedBefore = JSON.stringify(imageHistory);
    const calls = { value: 0 };
    const capturedInputs: ModelRequestInput[] = [];
    // Real AgentContextProjectorService (projector === undefined) so the wire
    // messages show the actual stripping, not the harness counter stub.
    const requester = createRequester(calls, null, [], capturedInputs, NO_VISION_CAPABILITIES);
    const { service, wire, records } = createService(requester, undefined, {
      history: imageHistory,
    });
    const switchCapabilities = (capabilities: ModelCapability) => {
      Object.defineProperty(requester.model, 'capabilities', {
        value: capabilities,
        configurable: true,
      });
    };

    await service.request({ source: { type: 'turn', turnId: 1, step: 1 } });
    switchCapabilities(VISION_CAPABILITIES);
    await service.request({ source: { type: 'turn', turnId: 2, step: 1 } });
    switchCapabilities(NO_VISION_CAPABILITIES);
    await service.request({ source: { type: 'turn', turnId: 2, step: 2 } });

    expect(calls.value).toBe(3);
    const [noVisionWire, visionWire, noVisionAgainWire] = capturedInputs;
    const parts = (input: ModelRequestInput) => input.messages.flatMap((message) => message.content);
    // ① the no-vision turns project differently from the vision turn.
    expect(parts(noVisionWire!).some((part) => part.type === 'image_url')).toBe(false);
    expect(
      parts(noVisionWire!).some(
        (part) =>
          part.type === 'text' &&
          part.text.includes('omitted for provider compatibility') &&
          part.text.includes('image'),
      ),
    ).toBe(true);
    expect(parts(visionWire!).some((part) => part.type === 'image_url')).toBe(true);
    expect(parts(noVisionAgainWire!).some((part) => part.type === 'image_url')).toBe(false);
    await wire.flush();
    expect(
      records
        .filter((record) => record.type === 'llm.request')
        .map((record) => record['projection']),
    ).toEqual(['media-stripped', undefined, 'media-stripped']);

    // ③ the vision turn sent the stored image on the wire unchanged.
    expect(
      parts(visionWire!).find((part) => part.type === 'image_url'),
    ).toMatchObject({ imageUrl: { url: IMAGE_URL, id: 'img-1' } });

    // ② context memory still holds the image untouched after the gated turns.
    expect(JSON.stringify(imageHistory)).toBe(storedBefore);
    expect(
      imageHistory[0]!.content.some(
        (part) => part.type === 'image_url' && part.imageUrl.url === IMAGE_URL,
      ),
    ).toBe(true);
  });

  it('strips audio parts for a model declared without audio input', async () => {
    // The gate now names audio_url in its mask: a no-audio model replaces
    // audio parts with the compatibility placeholder on the wire.
    const calls = { value: 0 };
    const capturedInputs: ModelRequestInput[] = [];
    const audioHistory: Message[] = [
      {
        role: 'user',
        content: [{ type: 'audio_url', audioUrl: { url: AUDIO_URL, id: 'au-1' } }],
        toolCalls: [],
      },
    ];
    const { service } = createService(
      createRequester(calls, null, [], capturedInputs, NO_VISION_CAPABILITIES),
      undefined,
      { history: audioHistory },
    );

    await service.request({ source: { type: 'turn', turnId: 1, step: 1 } });

    const wireParts = capturedInputs[0]!.messages.flatMap((message) => message.content);
    expect(wireParts.some((part) => part.type === 'audio_url')).toBe(false);
    expect(
      wireParts.some(
        (part) =>
          part.type === 'text' &&
          part.text.includes('audio omitted for provider compatibility'),
      ),
    ).toBe(true);
  });

  it('strips only audio for a model with image and video but no audio input', async () => {
    // Symmetric to the vision-no-video case: a model that lacks audio keeps
    // image and video on the wire and replaces only the audio part.
    const calls = { value: 0 };
    const capturedInputs: ModelRequestInput[] = [];
    const mixedHistory: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'image_url', imageUrl: { url: IMAGE_URL, id: 'img-1' } },
          { type: 'video_url', videoUrl: { url: VIDEO_URL, id: 'vid-1' } },
          { type: 'audio_url', audioUrl: { url: AUDIO_URL, id: 'au-1' } },
        ],
        toolCalls: [],
      },
    ];
    const { service } = createService(
      createRequester(calls, null, [], capturedInputs, VISION_NO_AUDIO_CAPABILITIES),
      undefined,
      { history: mixedHistory },
    );

    await service.request({ source: { type: 'turn', turnId: 1, step: 1 } });

    const wireParts = capturedInputs[0]!.messages.flatMap((message) => message.content);
    expect(wireParts.some((part) => part.type === 'image_url')).toBe(true);
    expect(wireParts.some((part) => part.type === 'video_url')).toBe(true);
    expect(wireParts.some((part) => part.type === 'audio_url')).toBe(false);
    expect(
      wireParts.some(
        (part) =>
          part.type === 'text' &&
          part.text.includes('audio omitted for provider compatibility'),
      ),
    ).toBe(true);
  });
});

describe('AgentLLMRequesterService media-degraded resend', () => {
  const BODY_TOO_LARGE_413 = new APIRequestTooLargeError(413, 'Request Entity Too Large');

  it('resends once with the media-degraded projection after an HTTP 413', async () => {
    const calls = { value: 0 };
    let projectCalls = 0;
    let degradedCalls = 0;
    let strippedCalls = 0;
    const { service } = createService(
      createRequester(
        calls,
        new Error2(ErrorCodes.PROVIDER_API_ERROR, 'Provider request failed', {
          cause: BODY_TOO_LARGE_413,
        }),
      ),
      {
        project: (messages: readonly ContextMessage[]) => {
          projectCalls += 1;
          return messages;
        },
        projectStrict: (messages: readonly ContextMessage[]) => messages,
        projectMediaDegraded: (messages: readonly ContextMessage[]) => {
          degradedCalls += 1;
          return messages;
        },
        projectMediaStripped: (messages: readonly ContextMessage[]) => {
          strippedCalls += 1;
          return messages;
        },
      },
    );

    const result = await service.request();

    expect(result.message.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(calls.value).toBe(2);
    expect(projectCalls).toBe(1);
    expect(degradedCalls).toBe(1);
    expect(strippedCalls).toBe(0);
  });

  it('falls back to media-stripped when the media-degraded request still receives 413', async () => {
    const calls = { value: 0 };
    let projectCalls = 0;
    let degradedCalls = 0;
    let strippedCalls = 0;
    const { service } = createService(
      createRequester(calls, BODY_TOO_LARGE_413, [BODY_TOO_LARGE_413]),
      {
        project: (messages: readonly ContextMessage[]) => {
          projectCalls += 1;
          return messages;
        },
        projectStrict: (messages: readonly ContextMessage[]) => messages,
        projectMediaDegraded: (messages: readonly ContextMessage[]) => {
          degradedCalls += 1;
          return messages;
        },
        projectMediaStripped: (messages: readonly ContextMessage[]) => {
          strippedCalls += 1;
          return messages;
        },
      },
    );

    const result = await service.request({ source: { type: 'turn', turnId: 1, step: 1 } });

    expect(result.message.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(calls.value).toBe(3);
    expect(projectCalls).toBe(1);
    expect(degradedCalls).toBe(1);
    expect(strippedCalls).toBe(1);
  });

  it('records repeated-413 recovery projections on the sticky later request', async () => {
    const calls = { value: 0 };
    const { service, wire, records } = createService(
      createRequester(calls, BODY_TOO_LARGE_413, [BODY_TOO_LARGE_413]),
      {
        project: (messages: readonly ContextMessage[]) => messages,
        projectStrict: (messages: readonly ContextMessage[]) => messages,
        projectMediaDegraded: (messages: readonly ContextMessage[]) => messages,
        projectMediaStripped: (messages: readonly ContextMessage[]) => messages,
      },
    );

    await service.request({ source: { type: 'turn', turnId: 1, step: 1 } });
    await service.request({ source: { type: 'turn', turnId: 1, step: 2 } });
    await wire.flush();

    expect(
      records
        .filter((record) => record.type === 'llm.request')
        .map((record) => record['projection']),
    ).toEqual([undefined, 'media-degraded', 'media-stripped', 'media-stripped']);
  });

  it('keeps new recovery media visible on later snapshot-stripped steps', async () => {
    const calls = { value: 0 };
    const capturedInputs: ModelRequestInput[] = [];
    const oldUrl = 'data:image/png;base64,REJECTED';
    const newUrl = 'data:image/png;base64,SMALL';
    const imageMessage = (url: string, id: string): Message => ({
      role: 'user',
      content: [{ type: 'image_url', imageUrl: { url, id } }],
      toolCalls: [],
    });
    const { service } = createService(
      createRequester(
        calls,
        BODY_TOO_LARGE_413,
        [BODY_TOO_LARGE_413],
        capturedInputs,
      ),
      undefined,
    );

    await service.request({
      messages: [imageMessage(oldUrl, 'rejected-id')],
      source: { type: 'turn', turnId: 1, step: 1 },
    });
    await service.request({
      messages: [
        imageMessage(oldUrl, 'rejected-id'),
        imageMessage(newUrl, 'recovery-id'),
      ],
      source: { type: 'turn', turnId: 1, step: 2 },
    });

    const visibleUrls = capturedInputs
      .at(-1)
      ?.messages.flatMap((message) => message.content)
      .filter((part) => part.type === 'image_url')
      .map((part) => part.imageUrl.url);
    expect(visibleUrls).toEqual([newUrl]);
  });

  it('stops after the media-stripped request also receives 413', async () => {
    const calls = { value: 0 };
    let projectCalls = 0;
    let degradedCalls = 0;
    let strippedCalls = 0;
    const { service } = createService(
      createRequester(calls, BODY_TOO_LARGE_413, [BODY_TOO_LARGE_413, BODY_TOO_LARGE_413]),
      {
        project: (messages: readonly ContextMessage[]) => {
          projectCalls += 1;
          return messages;
        },
        projectStrict: (messages: readonly ContextMessage[]) => messages,
        projectMediaDegraded: (messages: readonly ContextMessage[]) => {
          degradedCalls += 1;
          return messages;
        },
        projectMediaStripped: (messages: readonly ContextMessage[]) => {
          strippedCalls += 1;
          return messages;
        },
      },
    );

    await expect(
      service.request({ source: { type: 'turn', turnId: 1, step: 1 } }),
    ).rejects.toBe(BODY_TOO_LARGE_413);
    expect(calls.value).toBe(3);
    expect(projectCalls).toBe(1);
    expect(degradedCalls).toBe(1);
    expect(strippedCalls).toBe(1);
  });

  it('keeps later steps of the same turn on the degraded projection', async () => {
    const calls = { value: 0 };
    let projectCalls = 0;
    let degradedCalls = 0;
    const { service } = createService(createRequester(calls, BODY_TOO_LARGE_413), {
      project: (messages: readonly ContextMessage[]) => {
        projectCalls += 1;
        return messages;
      },
      projectStrict: (messages: readonly ContextMessage[]) => messages,
      projectMediaDegraded: (messages: readonly ContextMessage[]) => {
        degradedCalls += 1;
        return messages;
      },
    });

    await service.request({ source: { type: 'turn', turnId: 1, step: 1 } });
    expect(calls.value).toBe(2);
    expect(projectCalls).toBe(1);
    expect(degradedCalls).toBe(1);

    await service.request({ source: { type: 'turn', turnId: 1, step: 2 } });
    expect(calls.value).toBe(3);
    expect(projectCalls).toBe(1);
    expect(degradedCalls).toBe(2);
  });

  it('does not resend for a plain 400 or a non-413 status', async () => {
    for (const error of [
      new APIStatusError(400, 'max_tokens must be positive'),
      new APIStatusError(422, 'unprocessable'),
    ]) {
      const calls = { value: 0 };
      let degradedCalls = 0;
      const { service } = createService(createRequester(calls, error), {
        project: (messages: readonly ContextMessage[]) => messages,
        projectStrict: (messages: readonly ContextMessage[]) => messages,
        projectMediaDegraded: (messages: readonly ContextMessage[]) => {
          degradedCalls += 1;
          return messages;
        },
      });

      await expect(service.request()).rejects.toBe(error);
      expect(calls.value).toBe(1);
      expect(degradedCalls).toBe(0);
    }
  });
});

describe('AgentLLMRequesterService trace id', () => {
  const passthroughProjector = {
    project: (messages: readonly ContextMessage[]) => messages,
    projectStrict: (messages: readonly ContextMessage[]) => messages,
  };

  function createTracedRequester(traceId: string | null): ModelRequester {
    const model: Model = {
      id: 'm',
      name: 'wire-model',
      aliases: [],
      protocol: 'openai',
      baseUrl: 'https://example.test',
      headers: {},
      capabilities,
      maxContextSize: 1000,
      alwaysThinking: false,
      providerName: 'p',
      authProvider: { getAuth: async () => undefined },
    };
    return {
      model,
      request: async function* (_input, _signal, requestOptions) {
        requestOptions?.onTraceId?.(traceId);
        yield {
          type: 'finish',
          message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], toolCalls: [] },
          providerFinishReason: 'completed',
          rawFinishReason: 'stop',
          id: 'resp-1',
          traceId: traceId ?? undefined,
        };
      },
    };
  }

  it('exposes the request trace and returns it on finish', async () => {
    const requester = createTracedRequester('trace-req-1');
    const headersArrived = createControlledPromise<void>();
    const releaseStream = createControlledPromise<void>();
    Object.defineProperty(requester, 'request', {
      value: async function* (_input: unknown, _signal: unknown, requestOptions: {
        onTraceId?: (traceId: string | null) => void;
      }) {
        requestOptions.onTraceId?.('trace-req-1');
        headersArrived.resolve();
        await releaseStream;
        yield {
          type: 'finish',
          message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], toolCalls: [] },
          providerFinishReason: 'completed',
          rawFinishReason: 'stop',
          id: 'resp-1',
          traceId: 'trace-req-1',
        } satisfies ModelRequestEvent;
      },
    });
    const { service } = createService(requester, passthroughProjector);
    const request = service.start({ source: { type: 'turn', turnId: 1, step: 1 } });
    await headersArrived;
    expect(request.trace.traceId).toBe('trace-req-1');
    releaseStream.resolve();
    const finish = await request.result;

    expect(finish.traceId).toBe('trace-req-1');
    expect(request.trace.traceId).toBe('trace-req-1');
  });

  it('reports an absent trace before a request that returns none', async () => {
    const { service } = createService(createTracedRequester(null), passthroughProjector);
    const request = service.start();
    const finish = await request.result;

    expect(finish.traceId).toBeUndefined();
    expect(request.trace.traceId).toBeUndefined();
  });

  it('attaches trace_id, turn_id and step_no to api_error from the failed request', async () => {
    const requester = createTracedRequester(null);
    Object.defineProperty(requester, 'request', {
      value: async function* () {
        const events: ModelRequestEvent[] = [];
        for (const event of events) yield event;
        throw new APIStatusError(500, 'boom', 'req-1', null, 'trace-fail-1');
      },
    });
    const { service, telemetryRecords } = createService(requester, passthroughProjector);
    const request = service.start({ source: { type: 'turn', turnId: 3, step: 2 } });
    await expect(request.result).rejects.toMatchObject({ statusCode: 500 });

    expect(telemetryRecords).toContainEqual({
      event: 'api_error',
      properties: expect.objectContaining({
        error_type: '5xx_server',
        trace_id: 'trace-fail-1',
        turn_id: 3,
        step_no: 2,
      }),
    });
    expect(request.trace.traceId).toBe('trace-fail-1');
  });

  it('keeps the header-captured trace when the request fails after headers arrived', async () => {
    // A failure after the response headers arrived (empty response, mid-stream
    // decode error) carries no trace on the error itself; the trace captured
    // through the provider callback must remain on the request trace.
    const requester = createTracedRequester(null);
    Object.defineProperty(requester, 'request', {
      value: async function* (...args: unknown[]) {
        const requestOptions = args[2] as
          | { onTraceId?: (traceId: string | null) => void }
          | undefined;
        requestOptions?.onTraceId?.('trace-mid-stream');
        const events: ModelRequestEvent[] = [];
        for (const event of events) yield event;
        throw new APIEmptyResponseError('no content, no tool calls');
      },
    });
    const { service, telemetryRecords } = createService(requester, passthroughProjector);
    const request = service.start({ source: { type: 'turn', turnId: 4, step: 1 } });
    await expect(request.result).rejects.toThrow();

    const apiError = telemetryRecords.find((record) => record.event === 'api_error');
    expect(apiError?.properties?.['trace_id']).toBe('trace-mid-stream');
    expect(request.trace.traceId).toBe('trace-mid-stream');
  });

  it('clears the previous physical request trace before a projection retry', async () => {
    const requester = createTracedRequester(null);
    let attempts = 0;
    Object.defineProperty(requester, 'request', {
      value: async function* (...args: unknown[]) {
        const events: ModelRequestEvent[] = [];
        for (const event of events) yield event;
        attempts += 1;
        const requestOptions = args[2] as
          | { onTraceId?: (traceId: string | null) => void }
          | undefined;
        if (attempts === 1) {
          requestOptions?.onTraceId?.('trace-first-projection');
          throw new APIRequestTooLargeError(413, 'retry with degraded media');
        }
        throw new APIConnectionError('socket hang up');
      },
    });
    const { service, telemetryRecords } = createService(requester, passthroughProjector);
    const request = service.start();
    await expect(request.result).rejects.toThrow('socket hang up');

    expect(attempts).toBe(2);
    expect(request.trace.traceId).toBeUndefined();
    expect(
      telemetryRecords.find((record) => record.event === 'api_error')?.properties?.['trace_id'],
    ).toBeUndefined();
  });
});
