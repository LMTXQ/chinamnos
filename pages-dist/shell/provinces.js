/* ── 省份表（前端唯一副本）──
   ▸ 省份代码与采集端 chinamnos.py 的 PROVINCES 主代码一致（digest join 键）。
   ▸ 消费方：shell/auth.js（用户采集播报省份网格）、modules/config/config.js（站长配置页）。
   ▸ 运营商支持范围/附加省份（如广电"全网/深圳"）由消费方自行扩展（config.js 的 CFG_CARRIER_EXTRA_PROVS）。 */

export const PROVINCES = [
  { name: "北京市", code: "bj" }, { name: "广东省", code: "gd" }, { name: "江苏省", code: "js" },
  { name: "上海市", code: "sh" }, { name: "天津市", code: "tj" }, { name: "重庆市", code: "cq" },
  { name: "辽宁省", code: "ln" }, { name: "湖北省", code: "hub" }, { name: "四川省", code: "sc" },
  { name: "陕西省", code: "snx" }, { name: "河北省", code: "he" }, { name: "山西省", code: "sx" },
  { name: "河南省", code: "hn" }, { name: "吉林省", code: "jl" }, { name: "黑龙江省", code: "hlj" },
  { name: "内蒙古", code: "nmg" }, { name: "浙江省", code: "zj" }, { name: "安徽省", code: "ah" },
  { name: "山东省", code: "sd" }, { name: "福建省", code: "fj" }, { name: "江西省", code: "jx" },
  { name: "湖南省", code: "hun" }, { name: "广西", code: "gx" }, { name: "贵州省", code: "gz" },
  { name: "云南省", code: "yn" }, { name: "海南省", code: "han" }, { name: "西藏", code: "xz" },
  { name: "甘肃省", code: "gs" }, { name: "青海省", code: "qh" }, { name: "宁夏", code: "nx" },
  { name: "新疆", code: "xj" },
];
