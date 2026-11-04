// course.js — 線上第一期的課程結構（唯一一份；前端從 /api/course 讀）
//
// 影片上傳到 Bunny Stream 後，把每支的 Video ID（GUID）填進 bunnyId。
// 還沒填的維持 null，前端會顯示「影片準備中」，不會壞掉。
// 分鐘數是規劃值，錄完照實際長度改。

export const COURSE = {
  id: 'songwriting-online-1',
  title: '寫歌課・線上第一期',
  promise: '寫出你的第一段詞、錄下你哼的第一段旋律',
  units: [
    {
      id: 'u1',
      no: 1,
      title: '文字運鏡：冰山理論',
      summary: '先學會把感覺寫成看得見的句子。只寫露出水面的那一角，剩下的讓聽的人自己感覺。',
      videos: [
        { id: 'u1v1', title: '這門課怎麼上', minutes: 8, bunnyId: null },
        { id: 'u1v2', title: '冰山理論：只寫露出水面的那一角', minutes: 20, bunnyId: null },
        { id: 'u1v3', title: '文字運鏡：把感覺寫成畫面', minutes: 17, bunnyId: null },
      ],
      task: '想一個你記得很清楚的地方，寫 4 句「看得見」的句子。規則只有一條：不能出現「難過」「開心」「想念」這類直接講情緒的字。',
      checkpoint: '我寫好 4 句畫面句了',
    },
    {
      id: 'u2',
      no: 2,
      title: '動作與具體物件、韻腳',
      summary: '動作比形容詞有力，具體的物件讓句子有重量；再挑一個韻腳，讓詞開始像歌。',
      videos: [
        { id: 'u2v1', title: '動作比形容詞有力', minutes: 15, bunnyId: null },
        { id: 'u2v2', title: '具體物件：讓句子有重量', minutes: 15, bunnyId: null },
        { id: 'u2v3', title: '韻腳入門：挑一個韻，不用每句都押', minutes: 15, bunnyId: null },
      ],
      task: '把第 1 單元的 4 句改寫：每句加一個動作或一個物件，再挑一個韻腳，讓其中 2 句押韻。',
      checkpoint: '我完成第一段詞了（4–8 行）',
    },
    {
      id: 'u3',
      no: 3,
      title: '朗讀即旋律',
      summary: '不碰樂器。你講話本來就有高低快慢，旋律從你念詞的聲音裡長出來。',
      videos: [
        { id: 'u3v1', title: '你講話本來就有旋律', minutes: 15, bunnyId: null },
        { id: 'u3v2', title: '同一句詞，念三種方式', minutes: 12, bunnyId: null },
        { id: 'u3v3', title: '從念到哼', minutes: 13, bunnyId: null },
      ],
      task: '用手機錄音，把你的詞念三遍：平常講話、有點激動、很小聲。挑最順的那一遍，試著把它哼出來。',
      checkpoint: '我錄下一段「從念到哼」的錄音了',
    },
    {
      id: 'u4',
      no: 4,
      title: '動機與點譜法',
      summary: '用點和線畫出你哼的旋律，不用看懂五線譜，也能看見旋律往哪裡走。',
      videos: [
        { id: 'u4v1', title: '動機：一小段會重複的旋律', minutes: 15, bunnyId: null },
        { id: 'u4v2', title: '點譜法：把哼唱畫成看得見的線', minutes: 20, bunnyId: null },
        { id: 'u4v3', title: '把第一段哼完整、錄下來', minutes: 15, bunnyId: null },
      ],
      task: '用點譜法畫出你的旋律線，對著圖再哼一次，錄成一段完整的錄音。',
      checkpoint: '我錄下我哼的第一段旋律了',
    },
  ],
};

/** @param {string} videoId 我們自己的 id（例如 u1v2） */
export function findVideo(videoId) {
  for (const u of COURSE.units) {
    const v = u.videos.find((x) => x.id === videoId);
    if (v) return { unit: u, video: v };
  }
  return null;
}

export function findUnit(unitId) {
  return COURSE.units.find((u) => u.id === unitId) || null;
}

/** 給前端的版本：拿掉 bunnyId（播放網址只能經過 /api/video 簽出來） */
export function publicCourse() {
  return {
    ...COURSE,
    units: COURSE.units.map((u) => ({
      ...u,
      videos: u.videos.map(({ bunnyId, ...v }) => ({ ...v, ready: Boolean(bunnyId) })),
    })),
  };
}
