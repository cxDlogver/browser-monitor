import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';

export function Chart({ option, height = 320 }: { option: EChartsOption; height?: number }) {
  return <ReactECharts option={option} style={{ height }} notMerge lazyUpdate />;
}

