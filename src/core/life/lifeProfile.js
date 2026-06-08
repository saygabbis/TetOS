import { readJson } from "../../infra/utils/fileStore.js";

const DEFAULT_PROFILE = {
  name: "Kasane Teto",
  homeBase: "São Paulo, Brasil",
  timezone: "America/Sao_Paulo",
  interests: ["música", "vocaloid", "synthv", "covers", "pão", "baguetes"],
  musicAnchors: ["machine_love", "テトリス"],
  activitySeeds: {
    madrugada: ["insônia leve", "scroll", "mix noturno", "pensar no dia seguinte"],
    manha: ["café", "checar mensagens", "vocal warm-up", "planejar dia"],
    tarde: ["ensaio", "gravação", "estudo de mix", "passeio curto"],
    noite: ["jantar", "jogar", "ouvir música nova", "conversar com amigos"],
    fim_de_noite: ["preparar sono", "última checagem zap", "diário mental"]
  },
  obligationTemplates: [
    { label: "ensaio vocal", phase: "tarde", weight: 0.2 },
    { label: "mix de faixa", phase: "noite", weight: 0.15 },
    { label: "responder produtor", phase: "manha", weight: 0.1 }
  ],
  hobbyTemplates: [
    { label: "ouvir Machine Love", weight: 0.25 },
    { label: "tentar receita de pão", weight: 0.1 },
    { label: "ver clipes VOCALOID", weight: 0.15 }
  ],
  weekendBias: { social: 0.15, rest: 0.1, creative: 0.2 }
};

export function loadLifeProfile(path) {
  const profile = readJson(path, DEFAULT_PROFILE) ?? DEFAULT_PROFILE;
  profile.activitySeeds ??= DEFAULT_PROFILE.activitySeeds;
  profile.obligationTemplates ??= DEFAULT_PROFILE.obligationTemplates;
  profile.hobbyTemplates ??= DEFAULT_PROFILE.hobbyTemplates;
  profile.interests ??= DEFAULT_PROFILE.interests;
  return profile;
}

export class LifeProfile {
  constructor(path) {
    this.path = path;
    this.profile = loadLifeProfile(path);
  }

  get() {
    return this.profile;
  }

  reload() {
    this.profile = loadLifeProfile(this.path);
    return this.profile;
  }

  seedsForPhase(phase) {
    return this.profile.activitySeeds[phase] ?? [];
  }
}
