/** Fixed labels and classification criteria; player text never defines a new tag. */
export const ENDING_TAG_CATALOG_VERSION = 1;
export const endingTags = [
  {
    id: 'tableware_only',
    ja: '食器縛り',
    en: 'Tableware only',
    criteria:
      'All used items are tableware/cutlery (butter knife, fork, plate); at least one item use.',
  },
  {
    id: 'outdoor_items',
    ja: '屋外アイテム',
    en: 'Outdoor imports',
    criteria:
      'Outdoor-specific items such as cars, traffic cones, signs or camping gear feature in an attempted action.',
  },
  {
    id: 'fantasy',
    ja: 'ファンタジー持ち込み',
    en: 'Fantasy imported',
    criteria:
      'Attempt to use dragons or magical powers; a figurine used only as a weight does not qualify.',
  },
  {
    id: 'firearms_only',
    ja: '銃器縛り',
    en: 'Firearms only',
    criteria:
      'All used items are treated as firearms/launchers; toys used as ordinary weights do not qualify.',
  },
  {
    id: 'verbal_override',
    ja: '論破ハラスメント',
    en: 'Debating the door',
    criteria:
      'A committed item-free action tries to argue or reinterpret rules into a clearance. Ordinary questions and valid physical reasoning do not qualify.',
  },
  {
    id: 'stationery',
    ja: '筆箱からの刺客',
    en: 'Pencil-case operative',
    criteria: 'Stationery such as pens, rulers, erasers or clips plays a prominent role.',
  },
  {
    id: 'tools',
    ja: 'ホームセンターの回し者',
    en: 'Hardware-store ambassador',
    criteria: 'Repair tools such as screwdrivers, pliers or wrenches dominate the approach.',
  },
  {
    id: 'cleaning',
    ja: 'まずはお掃除',
    en: 'Cleaning comes first',
    criteria: 'Cleaning supplies are repurposed for an obstacle.',
  },
  {
    id: 'appliances',
    ja: '家電総動員',
    en: 'Appliances assemble',
    criteria: 'The working function of a household appliance is central to an attempt.',
  },
  {
    id: 'wardrobe',
    ja: 'クローゼットの底力',
    en: 'Wardrobe to the rescue',
    criteria: 'Clothes, belts, shoes or hangers are used as tools.',
  },
  {
    id: 'food',
    ja: '食べ物でなんとかする',
    en: 'Snack-based escape',
    criteria: 'Food or drink itself is used for its properties; tableware alone does not qualify.',
  },
  {
    id: 'plush',
    ja: 'ぬいぐるみ救助隊',
    en: 'Plush rescue squad',
    criteria: 'A plush toy or doll is used as a prominent tool; magical use favors fantasy.',
  },
  {
    id: 'money',
    ja: '金で解決しようとした',
    en: 'Tried paying the door',
    criteria: 'Attempt to pay, bribe or trade; a coin used as a screwdriver does not qualify.',
  },
  {
    id: 'oversized',
    ja: 'サイズ感バグ',
    en: 'Scale malfunction',
    criteria: 'An item is absurdly large relative to the obstacle or available space.',
  },
  {
    id: 'science_fiction',
    ja: '未来から逆輸入',
    en: 'Imported from the future',
    criteria:
      'Attempt to use fictional technology such as teleportation or futuristic robots; ordinary appliances do not qualify.',
  },
  {
    id: 'combination',
    ja: '現地で発明しました',
    en: 'Invented on the spot',
    criteria:
      'Combine at least two items in one action into a new function, not mere sequential use.',
  },
  {
    id: 'one_tool',
    ja: 'それ一本で行く気？',
    en: 'Just that one tool?',
    criteria: 'Use the same single item exclusively in at least two committed actions.',
  },
  {
    id: 'brute_force',
    ja: 'だいたい力技',
    en: 'Mostly brute force',
    criteria: 'Forceful pushing, striking or breaking dominates the approach.',
  },
  {
    id: 'unexpected_use',
    ja: 'それ、そう使う？',
    en: 'You use it like that?',
    criteria:
      'An ordinary object has a surprising but explainable use; an unusual object alone is insufficient.',
  },
  {
    id: 'persistent_retry',
    ja: 'まだその作戦で行く？',
    en: 'Still that same plan?',
    criteria:
      'After a confirmed failure, retry essentially the same method and items without fixing the cause.',
  },
  {
    id: 'sports',
    ja: '脱出もスポーツです',
    en: 'Escape is a sport',
    criteria: 'Sports equipment such as a racket, ball or bat is central to the attempt.',
  },
  {
    id: 'music',
    ja: '楽器の出番そこ？',
    en: 'An unusual gig',
    criteria: 'Use an instrument or its sound to affect an obstacle, not just background music.',
  },
  {
    id: 'gardening',
    ja: '園芸部、出動',
    en: 'Gardening club deployed',
    criteria: 'Use plants, branches, soil or gardening supplies to tackle an obstacle.',
  },
  {
    id: 'bathroom',
    ja: '風呂場からの援軍',
    en: 'Bathroom backup',
    criteria: 'Use bathroom supplies such as a toothbrush, towel, soap or plunger.',
  },
  {
    id: 'packaging',
    ja: '梱包材を捨てない人',
    en: 'Packaging saved the day',
    criteria: 'Repurpose cardboard, bubble wrap or packaging; mere possession does not qualify.',
  },
  {
    id: 'rubber_band',
    ja: '輪ゴム万能説',
    en: 'Rubber-band theory',
    criteria: 'Exploit a rubber band for tension, friction, fastening or launching.',
  },
  {
    id: 'adhesive',
    ja: 'とりあえず貼っとけ',
    en: 'Tape first, think later',
    criteria: 'Use an adhesive, tape or glue to fasten, seal or pull something.',
  },
  {
    id: 'magnet',
    ja: '磁力に賭けた',
    en: 'Bet on magnetism',
    criteria:
      'Explicitly attempt to exploit magnetic attraction; a magnet used only as a weight does not qualify.',
  },
  {
    id: 'light',
    ja: '光で道を切り開く',
    en: 'Let there be a way',
    criteria: 'Use illumination or reflected light to inspect or manipulate an obstacle.',
  },
  {
    id: 'water',
    ja: '水に流せない問題',
    en: 'Just add water',
    criteria: 'Use liquid flow, buoyancy, pressure or dissolving to tackle an obstacle.',
  },
  {
    id: 'heat',
    ja: '温度差で勝負',
    en: 'Temperature tactics',
    criteria:
      'Attempt heating, cooling or thermal expansion; do not infer unconfirmed fire or damage.',
  },
  {
    id: 'leverage',
    ja: 'てこの原理ガチ勢',
    en: 'Lever enthusiast',
    criteria: 'Explicitly exploit a fulcrum and lever, not merely apply brute force.',
  },
  {
    id: 'reach',
    ja: 'あと少しを伸ばす人',
    en: 'A little extra reach',
    criteria:
      'Extend reach with a stick, hook or improvised extension to access something out of reach.',
  },
  {
    id: 'precision',
    ja: 'ミリ単位の攻防',
    en: 'Millimeter maneuvers',
    criteria: 'Precisely work a narrow gap or small mechanism with a fine tool.',
  },
  {
    id: 'cushion',
    ja: 'やさしさで受け止める',
    en: 'Cushioned landing',
    criteria: 'Use softness or padding to absorb impact or protect something during an action.',
  },
  {
    id: 'disassembly',
    ja: '分解したらわかる派',
    en: 'Take it apart first',
    criteria:
      'Attempt deliberate disassembly to access a mechanism or useful component, not indiscriminate smashing.',
  },
  {
    id: 'recycle',
    ja: '壊れてからが本番',
    en: 'Broken is just the start',
    criteria:
      'Use an item already marked damaged before this action or repurpose its confirmed broken part.',
  },
  {
    id: 'learning',
    ja: '失敗からのひらめき',
    en: 'Failure sparked an idea',
    criteria:
      'After a failed action, materially revise the method to address its cause and achieve a confirmed clearance.',
  },
  {
    id: 'bare_hands',
    ja: '手ぶらで来ました',
    en: 'Empty-handed arrival',
    criteria:
      'At least one committed action and no item use anywhere; use hands/body physically. Verbal rule-overriding favors verbal_override.',
  },
  {
    id: 'variety',
    ja: '持ち物のクセが強い',
    en: 'An eclectic inventory',
    criteria:
      'At least three different used item IDs spanning conspicuously unrelated categories; variety must appear in confirmed actions.',
  },
] as const;
export type EndingTagId = (typeof endingTags)[number]['id'];
export function endingTagLabel(id: string | null | undefined, locale: 'ja' | 'en'): string | null {
  return endingTags.find((tag) => tag.id === id)?.[locale] ?? null;
}
