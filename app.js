const DATA = window.TANK_DATA;
const tanks = DATA.tanks || [];
const tankById = new Map(tanks.map((tank) => [tank.id, normalizeTank(tank)]));
let currentTank = null;
let lastResultText = "";

function normalizeTank(tank) {
  const capacityMap = new Map(tank.capacity.map((row) => [row.height_mm, row.volume_kl]));
  const capacityHeights = tank.capacity.map((row) => row.height_mm).sort((a, b) => a - b);
  const pressureMap = new Map(tank.static_pressure.map((row) => [row.height_mm, row.delta_kl_at_density_1]));
  const pressureHeights = tank.static_pressure.map((row) => row.height_mm).sort((a, b) => a - b);
  const extras = tank.millimeter_extras.map((row) => ({
    ...row,
    extras: Object.fromEntries(Object.entries(row.extras).map(([key, value]) => [Number(key), value])),
  }));
  return { ...tank, capacityMap, capacityHeights, pressureMap, pressureHeights, extras };
}

function initTankSelect() {
  const select = document.getElementById("tankSelect");
  select.innerHTML = tanks
    .map((tank) => `<option value="${tank.id}">${tank.name}</option>`)
    .join("");
  select.value = DATA.default_tank_id || tanks[0]?.id || "";
  select.addEventListener("change", () => {
    setCurrentTank(select.value);
    calculate();
  });
  setCurrentTank(select.value);
}

function setCurrentTank(tankId) {
  currentTank = tankById.get(tankId) || tankById.get(DATA.default_tank_id) || tanks[0];
  const roofMode = document.getElementById("roofMode");
  if (currentTank && currentTank.floating_roof_mass_kg > 0) {
    roofMode.disabled = false;
    roofMode.title = "";
  } else {
    roofMode.value = "auto";
    roofMode.disabled = true;
    roofMode.title = "该储罐未识别到浮顶质量，默认不做浮顶扣除";
  }
}

function parseNumber(raw) {
  if (typeof raw !== "string") return Number(raw);
  const value = raw.trim().replace(",", ".");
  const match = value.match(/^(-?\d+(?:\.\d+)?)(mm|毫米|cm|厘米|m|米)?$/i);
  if (!match) return NaN;
  const num = Number(match[1]);
  const unit = (match[2] || "").toLowerCase();
  if (unit === "m" || unit === "米") return num * 1000;
  if (unit === "cm" || unit === "厘米") return num * 10;
  return num;
}

function parseDensity(raw) {
  const value = String(raw).trim().replace(",", ".");
  if (!value) return NaN;
  const num = Number(value);
  if (!Number.isFinite(num)) return NaN;
  return num > 10 ? num / 1000 : num;
}

function fmt(value, digits = 3) {
  if (!Number.isFinite(value)) return "--";
  return value.toLocaleString("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function findPreviousHeight(heights, levelMm) {
  let lo = 0;
  let hi = heights.length - 1;
  let best = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (heights[mid] <= levelMm) {
      best = heights[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function findNearestPressureHeight(tank, levelMm, mode) {
  if (mode === "nearest") {
    let best = tank.pressureHeights[0];
    let bestDist = Math.abs(levelMm - best);
    for (const height of tank.pressureHeights) {
      const dist = Math.abs(levelMm - height);
      if (dist < bestDist) {
        best = height;
        bestDist = dist;
      }
    }
    return best;
  }
  return findPreviousHeight(tank.pressureHeights, levelMm) ?? tank.pressureHeights[0];
}

function getMillimeterExtra(tank, levelMm, remainderMm) {
  if (remainderMm === 0) return { value: 0, range: null };
  const range = tank.extras.find((row) => levelMm > row.start_mm && levelMm <= row.end_mm);
  if (!range || range.extras[remainderMm] == null) {
    throw new Error("未找到该液位所在区间的毫米容量补充值。");
  }
  return { value: range.extras[remainderMm], range };
}

function lookupCapacity(tank, levelMm) {
  const rounded = Math.round(levelMm);
  const exact = tank.capacityMap.get(rounded);
  if (exact != null) {
    return {
      roundedLevelMm: rounded,
      baseMm: rounded,
      remainderMm: 0,
      baseVolume: exact,
      mmExtra: 0,
      mmRange: null,
      tableVolume: exact,
    };
  }

  const baseMm = findPreviousHeight(tank.capacityHeights, rounded);
  if (baseMm == null) throw new Error("未找到该液位的容量表基准值。");
  const remainderMm = rounded - baseMm;
  if (remainderMm < 0 || remainderMm > 9) {
    throw new Error("该液位不在容量表可补算的毫米范围内。");
  }
  const base = tank.capacityMap.get(baseMm);
  const extra = getMillimeterExtra(tank, rounded, remainderMm);
  return {
    roundedLevelMm: rounded,
    baseMm,
    remainderMm,
    baseVolume: base,
    mmExtra: extra.value,
    mmRange: extra.range,
    tableVolume: base + extra.value,
  };
}

function lookupPressure(tank, levelMm, mode) {
  const key = findNearestPressureHeight(tank, Math.round(levelMm), mode);
  return { pressureHeightMm: key, deltaAtDensity1: tank.pressureMap.get(key) || 0 };
}

function validate(tank, levelMm, density, liquidTemp, airTemp) {
  const messages = [];
  let blocked = false;
  const minHeight = tank.capacityHeights[0];
  const maxHeight = tank.capacityHeights[tank.capacityHeights.length - 1];

  if (!Number.isFinite(levelMm)) {
    messages.push({ type: "error", text: "液位高度输入无效。" });
    blocked = true;
  }
  if (!Number.isFinite(density) || density <= 0) {
    messages.push({ type: "error", text: "20℃密度输入无效。" });
    blocked = true;
  }
  if (!Number.isFinite(liquidTemp) || !Number.isFinite(airTemp)) {
    messages.push({ type: "error", text: "温度输入无效。" });
    blocked = true;
  }
  if (Number.isFinite(levelMm)) {
    if (levelMm < minHeight) {
      messages.push({ type: "error", text: `液位低于 ${tank.short_name} 容量表起点 ${minHeight} mm。` });
      blocked = true;
    }
    if (levelMm > maxHeight) {
      messages.push({ type: "error", text: `液位超过 ${tank.short_name} 容量表终点 ${maxHeight} mm。` });
      blocked = true;
    }
    if (
      tank.invalid_min_height_mm != null &&
      tank.invalid_min_height_mm > minHeight &&
      levelMm <= tank.invalid_min_height_mm
    ) {
      messages.push({ type: "error", text: `${tank.short_name}：${tank.invalid_min_height_mm} mm（含）以下不作计量。` });
      blocked = true;
    }
    if (
      tank.invalid_band_start_mm != null &&
      tank.invalid_band_end_mm != null &&
      levelMm >= tank.invalid_band_start_mm &&
      levelMm <= tank.invalid_band_end_mm
    ) {
      messages.push({
        type: "error",
        text: `${tank.short_name}：液位在 ${tank.invalid_band_start_mm} mm - ${tank.invalid_band_end_mm} mm 区间，不得作为计量使用。`,
      });
      blocked = true;
    }
  }
  if (Number.isFinite(density) && density <= 0.0011 && tank.floating_roof_mass_kg > 0) {
    messages.push({ type: "error", text: "密度过低，无法进行浮顶体积修正。" });
    blocked = true;
  }
  return { messages, blocked };
}

function calculate() {
  const tank = currentTank;
  const levelMm = parseNumber(document.getElementById("levelInput").value);
  const density = parseDensity(document.getElementById("densityInput").value);
  const liquidTemp = Number(document.getElementById("liquidTempInput").value.replace(",", "."));
  const airTemp = Number(document.getElementById("airTempInput").value.replace(",", "."));
  const pressureMode = document.getElementById("pressureMode").value;
  const roofMode = document.getElementById("roofMode").value;
  const validation = validate(tank, levelMm, density, liquidTemp, airTemp);
  const messages = [...validation.messages];

  if (validation.blocked) {
    renderMessages(messages);
    renderEmpty();
    return;
  }

  try {
    const cap = lookupCapacity(tank, levelMm);
    const pressure = lookupPressure(tank, cap.roundedLevelMm, pressureMode);
    const deltaPressure = pressure.deltaAtDensity1 * density;
    const wallTemp = ((7 * liquidTemp) + airTemp) / 8;
    const alpha = tank.alpha ?? DATA.calculation_basis.alpha ?? 0.000012;
    const correctedVolume = (cap.tableVolume + deltaPressure) * (1 + 2 * alpha * (wallTemp - 20));
    const shouldDeductRoof =
      roofMode === "auto" &&
      tank.floating_roof_mass_kg > 0 &&
      tank.invalid_band_end_mm != null &&
      cap.roundedLevelMm > tank.invalid_band_end_mm;
    const roofVolume = shouldDeductRoof
      ? tank.floating_roof_mass_kg / ((density - 0.0011) * 1000)
      : 0;
    const finalVolume = correctedVolume - roofVolume;
    const massTon = finalVolume * density;
    const massKg = massTon * 1000;

    messages.push({ type: "ok", text: `${tank.short_name} 计算完成。结果按实际质量输出，静压力修正已启用。` });
    if (cap.roundedLevelMm !== levelMm) {
      messages.push({ type: "warn", text: `液位已按最接近的整毫米 ${cap.roundedLevelMm} mm 查表。` });
    }
    if (tank.floating_roof_mass_kg === 0) {
      messages.push({ type: "warn", text: `${tank.short_name} 未识别到浮顶质量，本次不做浮顶扣除。` });
    }

    const rows = [
      ["储罐", `${tank.name}（${tank.source}）`],
      ["查表液位", `${cap.roundedLevelMm} mm`],
      ["容量基准", `${cap.baseMm} mm → ${fmt(cap.baseVolume)} kL`],
      ["毫米补容量", `${cap.remainderMm} mm → ${fmt(cap.mmExtra)} kL`],
      ["容量表值 VB", `${fmt(cap.tableVolume)} kL`],
      ["静压力查表高度", `${pressure.pressureHeightMm} mm`],
      ["静压力表值", `${fmt(pressure.deltaAtDensity1)} kL`],
      ["静压力修正 ΔVP", `${fmt(deltaPressure)} kL`],
      ["罐壁温度", `${fmt(wallTemp, 2)} ℃`],
      ["温度修正后容量 Vt", `${fmt(correctedVolume)} kL`],
      ["浮顶扣除体积", `${fmt(roofVolume)} kL`],
      ["最终计量体积", `${fmt(finalVolume)} kL`],
      ["实际质量", `${fmt(massTon)} t / ${fmt(massKg, 0)} kg`],
    ];

    lastResultText = rows.map((row) => `${row[0]}：${row[1]}`).join("\n");
    renderMessages(messages);
    renderResults({ massTon, finalVolume, baseVolume: cap.tableVolume, rows });
  } catch (err) {
    renderMessages([{ type: "error", text: err.message }]);
    renderEmpty();
  }
}

function renderMessages(messages) {
  const box = document.getElementById("messages");
  box.innerHTML = messages.map((msg) => `<div class="message ${msg.type}">${msg.text}</div>`).join("");
}

function renderEmpty() {
  document.getElementById("massTon").textContent = "--";
  document.getElementById("finalVolume").textContent = "--";
  document.getElementById("baseVolume").textContent = "--";
  document.getElementById("detailRows").innerHTML = "";
  lastResultText = "";
}

function renderResults(result) {
  document.getElementById("massTon").textContent = fmt(result.massTon);
  document.getElementById("finalVolume").textContent = fmt(result.finalVolume);
  document.getElementById("baseVolume").textContent = fmt(result.baseVolume);
  document.getElementById("detailRows").innerHTML = result.rows
    .map((row) => `<tr><th>${row[0]}</th><td>${row[1]}</td></tr>`)
    .join("");
}

document.addEventListener("DOMContentLoaded", () => {
  initTankSelect();
  document.getElementById("calcForm").addEventListener("submit", (event) => {
    event.preventDefault();
    calculate();
  });
  document.getElementById("copyBtn").addEventListener("click", async () => {
    if (!lastResultText) calculate();
    if (!lastResultText) return;
    try {
      await navigator.clipboard.writeText(lastResultText);
      renderMessages([{ type: "ok", text: "结果已复制。" }]);
    } catch {
      renderMessages([{ type: "warn", text: "当前环境不允许自动复制，请手动选择计算过程内容复制。" }]);
    }
  });
  calculate();
});
