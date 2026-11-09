// course.js — 線上第一期的單元（固定 4 個）＋把 D1 的集數組成前端要的課程結構
//
// 單元 title／summary 要跟預購頁 /course-online/ 的四個單元文字一致：只寫概念與學完的收穫，不寫做法。
// task、checkpoint 只有登入的學員看得到，可以寫具體。
// 集數（影片）在 D1 的 episodes 表，後台 /course-online/admin/ 新增與排序；見 src/episodes.js。
// 單元文字後台也能改（D1 unit_overrides）；這裡是沒改過時的預設值。

export const COURSE = {
  id: 'songwriting-online-1',
  title: '寫歌課・線上第一期',
  promise: '寫出你的第一段詞、錄下你哼的第一段旋律',
  units: [
    {
      id: 'u1',
      no: 1,
      title: '冰山理論',
      summary: '學完這個單元，你寫下的句子會開始有畫面。',
      task: '想一個你記得很清楚的地方，寫 4 句「看得見」的句子。規則只有一條：不能出現「難過」「開心」「想念」這類直接講情緒的字。',
      checkpoint: '我寫好 4 句畫面句了',
    },
    {
      id: 'u2',
      no: 2,
      title: '詞的重量',
      summary: '這裡不會有填空式的押韻公式；學完，你會有一段念起來就像歌的詞。',
      task: '把第 1 單元的 4 句改寫：每句加一個動作或一個物件，再挑一個韻腳，讓其中 2 句押韻。',
      checkpoint: '我完成第一段詞了（4–8 行）',
    },
    {
      id: 'u3',
      no: 3,
      title: '旋律入門',
      summary: '不碰樂器也可以；學完，你會哼出這段詞的第一段旋律。',
      task: '用手機錄音，把你的詞念三遍：平常講話、有點激動、很小聲。挑最順的那一遍，試著把它哼出來。',
      checkpoint: '我錄下一段「從念到哼」的錄音了',
    },
    {
      id: 'u4',
      no: 4,
      title: '點譜法',
      summary: '把音樂視覺化；學完，你看得見自己的旋律往哪裡走。',
      task: '用點譜法畫出你的旋律線，對著圖再哼一次，錄成一段完整的錄音。',
      checkpoint: '我錄下我哼的第一段旋律了',
    },
  ],
};

export function findUnit(unitId) {
  return COURSE.units.find((u) => u.id === unitId) || null;
}

const UNIT_TEXT_FIELDS = ['title', 'summary', 'task', 'checkpoint'];
export const UNIT_TEXT_MAX = { title: 40, summary: 300, task: 1000, checkpoint: 200 };

/**
 * 四個單元＋後台改過的文字（D1 unit_overrides）。沒改過的欄位用上面 COURSE 的預設。
 * 單元的 id／no 固定（進度、作業都靠 id），只有文字可以改。
 */
export async function loadUnits(db) {
  let rows = [];
  try {
    ({ results: rows } = await db.prepare('SELECT id, title, summary, task, checkpoint FROM unit_overrides').all());
  } catch {
    rows = []; // 還沒跑 0003 migration：照預設
  }
  const over = Object.fromEntries((rows || []).map((r) => [r.id, r]));
  return COURSE.units.map((u) => {
    const o = over[u.id] || {};
    const out = { ...u };
    for (const k of UNIT_TEXT_FIELDS) if (o[k] != null && String(o[k]).trim() !== '') out[k] = String(o[k]);
    return out;
  });
}

export async function findUnitText(db, unitId) {
  return (await loadUnits(db)).find((u) => u.id === unitId) || null;
}

/**
 * 給前端的課程結構。youtube_id 一律不放進來（播放網址只能經過 /api/video 拿）。
 * @param {Array<{id:string, unit_id:string, title:string, youtube_id:string|null, duration_sec:number, free:boolean}>} episodes
 *   已經 markFree 過、只含已發布、照 sort 排好的集數
 * @param {object} o
 * @param {boolean} o.member         有登入（＝付過款的學員）
 * @param {boolean} o.entitled       付費集看得到（學員＋課程已開，或在預覽名單）
 * @param {boolean} o.freeOpen       免費集現在開放沒登入的人看
 * @param {boolean} o.showLockedTitles 鎖住的集數要不要顯示標題（預設不顯示：對外不寫做法）
 * @param {Array<object>} [o.units]   loadUnits() 的結果（含後台改過的文字）；沒給用預設
 */
export function publicCourse(episodes, { member, entitled, freeOpen, showLockedTitles, units = COURSE.units }) {
  return {
    id: COURSE.id,
    title: COURSE.title,
    promise: COURSE.promise,
    units: units.map((u) => {
      const eps = episodes.filter((e) => e.unit_id === u.id);
      return {
        id: u.id,
        no: u.no,
        title: u.title,
        summary: u.summary,
        task: member ? u.task : null,
        checkpoint: member ? u.checkpoint : null,
        minutes: Math.round(eps.reduce((s, e) => s + Number(e.duration_sec || 0), 0) / 60),
        episodes: eps.map((e, i) => {
          const unlocked = e.free ? freeOpen || entitled : entitled;
          return {
            id: e.id,
            no: i + 1,
            title: unlocked || e.free || showLockedTitles ? e.title : null,
            minutes: Math.max(1, Math.round(Number(e.duration_sec || 0) / 60)),
            free: e.free,
            unlocked,
            ready: Boolean(e.youtube_id),
          };
        }),
      };
    }),
  };
}
