import type { WorkflowPackKey } from "../types";
import type { Localized } from "./office-pack-presets";

const VIDEO_PREPROD_NAME_POOL: Partial<Record<string, Localized[]>> = {
  planning: [
    { ko: "비전", en: "Vision", ja: "ビジョン", zh: "Vision", de: "Vision" },
    { ko: "스크립트", en: "Script", ja: "スクリプト", zh: "Script", de: "Script" },
  ],
  dev: [
    { ko: "픽셀", en: "Pixel", ja: "ピクセル", zh: "Pixel", de: "Pixel" },
    { ko: "클립", en: "Clip", ja: "クリップ", zh: "Clip", de: "Clip" },
  ],
  qa: [{ ko: "렌즈", en: "Lens", ja: "レンズ", zh: "Lens", de: "Lens" }],
};

const WEB_RESEARCH_NAME_POOL: Partial<Record<string, Localized[]>> = {
  planning: [
    { ko: "세이지", en: "Sage", ja: "セージ", zh: "Sage", de: "Sage" },
    { ko: "스카우트", en: "Scout", ja: "スカウト", zh: "Scout", de: "Scout" },
  ],
  dev: [
    { ko: "크롤", en: "Crawl", ja: "クロール", zh: "Crawl", de: "Crawl" },
    { ko: "아카이브", en: "Archive", ja: "アーカイブ", zh: "Archive", de: "Archive" },
    { ko: "스파이더", en: "Spider", ja: "スパイダー", zh: "Spider", de: "Spider" },
    { ko: "비콘", en: "Beacon", ja: "ビーコン", zh: "Beacon", de: "Beacon" },
    { ko: "인덱스", en: "Index", ja: "インデックス", zh: "Index", de: "Index" },
  ],
  qa: [{ ko: "베리파이", en: "Verify", ja: "ベリファイ", zh: "Verify", de: "Verify" }],
};

export const PACK_NAME_POOL_OVERRIDES: Partial<Record<WorkflowPackKey, Partial<Record<string, Localized[]>>>> = {
  video_preprod: VIDEO_PREPROD_NAME_POOL,
  web_research_report: WEB_RESEARCH_NAME_POOL,
};

export const DEPARTMENT_PERSON_NAME_POOL: Partial<Record<string, Localized[]>> = {
  planning: [
    { ko: "세이지", en: "Sage", ja: "セージ", zh: "Sage", de: "Sage" },
    { ko: "미나", en: "Mina", ja: "ミナ", zh: "Mina", de: "Mina" },
    { ko: "주노", en: "Juno", ja: "ジュノ", zh: "Juno", de: "Juno" },
    { ko: "리안", en: "Rian", ja: "リアン", zh: "Rian", de: "Rian" },
    { ko: "하루", en: "Haru", ja: "ハル", zh: "Haru", de: "Haru" },
    { ko: "노아", en: "Noa", ja: "ノア", zh: "Noa", de: "Noa" },
  ],
  dev: [
    { ko: "아리아", en: "Aria", ja: "アリア", zh: "Aria", de: "Aria" },
    { ko: "테오", en: "Theo", ja: "テオ", zh: "Theo", de: "Theo" },
    { ko: "카이", en: "Kai", ja: "カイ", zh: "Kai", de: "Kai" },
    { ko: "리암", en: "Liam", ja: "リアム", zh: "Liam", de: "Liam" },
    { ko: "세나", en: "Sena", ja: "セナ", zh: "Sena", de: "Sena" },
    { ko: "로완", en: "Rowan", ja: "ローワン", zh: "Rowan", de: "Rowan" },
  ],
  design: [
    { ko: "도로", en: "Doro", ja: "ドロ", zh: "Doro", de: "Doro" },
    { ko: "루나", en: "Luna", ja: "ルナ", zh: "Luna", de: "Luna" },
    { ko: "픽셀", en: "Pixel", ja: "ピクセル", zh: "Pixel", de: "Pixel" },
    { ko: "유나", en: "Yuna", ja: "ユナ", zh: "Yuna", de: "Yuna" },
    { ko: "미로", en: "Miro", ja: "ミロ", zh: "Miro", de: "Miro" },
    { ko: "아이리스", en: "Iris", ja: "アイリス", zh: "Iris", de: "Iris" },
  ],
  qa: [
    { ko: "스피키", en: "Speaky", ja: "スピーキー", zh: "Speaky", de: "Speaky" },
    { ko: "호크", en: "Hawk", ja: "ホーク", zh: "Hawk", de: "Hawk" },
    { ko: "베라", en: "Vera", ja: "ヴェラ", zh: "Vera", de: "Vera" },
    { ko: "퀸", en: "Quinn", ja: "クイン", zh: "Quinn", de: "Quinn" },
    { ko: "토리", en: "Tori", ja: "トリ", zh: "Tori", de: "Tori" },
    { ko: "하윤", en: "Hayoon", ja: "ハユン", zh: "Hayoon", de: "Hayoon" },
  ],
};
