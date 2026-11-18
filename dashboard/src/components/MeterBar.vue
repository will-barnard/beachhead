<template>
  <div class="meter">
    <div class="track" role="meter" :aria-valuenow="value" aria-valuemin="0" aria-valuemax="100">
      <div class="fill" :class="level" :style="{ width: clamped + '%' }"></div>
    </div>
    <div v-if="level !== 'ok'" class="state" :class="level">
      {{ level === 'crit' ? '✕ Critical' : '⚠ Warning' }} — alert at {{ level === 'crit' ? rule.crit : rule.warn }}{{ rule.unit }}
    </div>
  </div>
</template>

<script>
/**
 * Usage bar. The fill carries severity (accent → warning → danger) against
 * the rule's thresholds; the track is a light step of the accent. State is
 * also spelled out in text, so it never depends on colour alone.
 */
export default {
  props: {
    value: { type: Number, default: 0 },
    rule: { type: Object, default: null },
  },
  computed: {
    clamped() { return Math.min(100, Math.max(0, this.value || 0)); },
    level() {
      const r = this.rule;
      if (!r || !r.enabled) return 'ok';
      if (r.crit != null && this.value >= r.crit) return 'crit';
      if (r.warn != null && this.value >= r.warn) return 'warn';
      return 'ok';
    },
  },
};
</script>

<style scoped>
.meter { margin: 0.4rem 0 0.35rem; }
.track { height: 6px; border-radius: 3px; background: rgba(79, 143, 247, 0.15); overflow: hidden; }
.fill { height: 100%; border-radius: 3px; background: var(--accent); }
.fill.warn { background: var(--warning); }
.fill.crit { background: var(--danger); }
.state { font-size: 0.72rem; margin-top: 0.2rem; }
.state.warn { color: var(--warning); }
.state.crit { color: var(--danger); }
</style>
