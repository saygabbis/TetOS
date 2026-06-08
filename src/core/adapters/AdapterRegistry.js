const STUB_VISION = {
  name: "stub_vision",
  async analyze(media = {}) {
    return {
      tags: ["visual"],
      emotionalTone: "neutral",
      description: media.path ? `imagem em ${media.path}` : "mídia visual recebida",
      source: "stub"
    };
  }
};

const STUB_VIDEO = {
  name: "stub_video",
  async extractFrames(media = {}) {
    return {
      frames: 3,
      tags: ["video", "motion"],
      source: "stub"
    };
  }
};

const STUB_WEB = {
  name: "stub_web",
  async search(query = "") {
    return [{ title: `resultado stub: ${query}`, url: null, snippet: "pesquisa não configurada" }];
  },
  async readUrl(url = "") {
    return { url, text: "leitura web não configurada (stub)", source: "stub" };
  }
};

const STUB_WORKER = {
  name: "stub_worker",
  async complete(prompt = "", { maxTokens = 200 } = {}) {
    return `[stub worker ${maxTokens}tok] ${String(prompt).slice(0, 80)}...`;
  },
  async summarize(text = "") {
    return String(text).slice(0, 120);
  }
};

export class AdapterRegistry {
  constructor({
    vision = null,
    video = null,
    web = null,
    worker = null
  } = {}) {
    this.vision = vision ?? STUB_VISION;
    this.video = video ?? STUB_VIDEO;
    this.web = web ?? STUB_WEB;
    this.worker = worker ?? STUB_WORKER;
  }

  getVision() {
    return this.vision;
  }

  getVideo() {
    return this.video;
  }

  getWeb() {
    return this.web;
  }

  getWorker() {
    return this.worker;
  }

  async analyze(media) {
    return this.vision.analyze(media);
  }

  async search(query) {
    return this.web.search(query);
  }

  async readUrl(url) {
    return this.web.readUrl(url);
  }

  async summarize(text) {
    return this.worker.summarize(text);
  }

  async complete(prompt, opts) {
    if (this.worker?.generate) {
      return this.worker.generate(prompt);
    }
    return this.worker.complete(prompt, opts);
  }

  list() {
    return {
      vision: this.vision.name ?? "custom",
      video: this.video.name ?? "custom",
      web: this.web.name ?? "custom",
      worker: this.worker.name ?? "custom"
    };
  }
}
