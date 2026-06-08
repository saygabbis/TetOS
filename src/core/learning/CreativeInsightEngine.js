import { contextualSeed, chance } from "../brain/rng.js";

const INSIGHT_TEMPLATES = [
  { type: "rhythm", build: (ctx) => `pico de conversa por volta das ${ctx.hour}h` },
  { type: "style", build: () => "mensagens curtas dominam quando o clima está leve" },
  { type: "media", build: () => "stickers aparecem mais quando o humor sobe" },
  { type: "topic", build: (ctx) => `assunto "${ctx.topic}" voltou várias vezes` },
  { type: "social", build: () => "grupo fica mais ativo à noite" }
];

export class CreativeInsightEngine {
  constructor({ bridge = null, bus = null } = {}) {
    this.bridge = bridge;
    this.bus = bus;
    this.recentEvents = [];
  }

  observe(event = {}) {
    this.recentEvents.push({ ...event, observedAt: Date.now() });
    if (this.recentEvents.length > 200) {
      this.recentEvents = this.recentEvents.slice(-200);
    }
    return this.maybeGenerate(event);
  }

  maybeGenerate(triggerEvent = {}) {
    const hour = new Date(triggerEvent.ts ?? Date.now()).getHours();
    const seed = contextualSeed([hour, triggerEvent.eventType, this.recentEvents.length]);
    if (!chance(seed, 0.04)) return null;

    const topic = triggerEvent.topic ?? this.inferTopic();
    const template = INSIGHT_TEMPLATES[seed % INSIGHT_TEMPLATES.length];
    const insight = {
      id: `insight_${Date.now()}`,
      type: template.type,
      text: template.build({ hour, topic }),
      confidence: 0.4 + (seed % 30) / 100,
      trigger: triggerEvent.eventType ?? "observed"
    };

    this.bridge?.addInsight(insight);
    this.bus?.emit("insight.generated", insight);
    return insight;
  }

  inferTopic() {
    const topics = this.recentEvents.map((e) => e.topic).filter(Boolean);
    if (!topics.length) return "conversa geral";
    const counts = {};
    for (const t of topics) counts[t] = (counts[t] ?? 0) + 1;
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "conversa geral";
  }

  generateFromWindow(events = []) {
    const insights = [];
    const byHour = {};
    for (const e of events) {
      const h = new Date(e.ts ?? Date.now()).getHours();
      byHour[h] = (byHour[h] ?? 0) + 1;
    }
    const peakHour = Object.entries(byHour).sort((a, b) => b[1] - a[1])[0];
    if (peakHour && peakHour[1] >= 3) {
      insights.push({
        type: "rhythm",
        text: `atividade concentrada perto das ${peakHour[0]}h`,
        confidence: 0.6
      });
    }
    for (const ins of insights) {
      this.bridge?.addInsight({ ...ins, id: `insight_${Date.now()}_${ins.type}` });
    }
    return insights;
  }

  tick() {
    if (this.recentEvents.length >= 20) {
      return this.generateFromWindow(this.recentEvents.slice(-50));
    }
    return [];
  }
}
