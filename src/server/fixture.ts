import type {PackageGraph} from '../shared/model';

// 固定的示例依赖图 revision。涵盖：
// - core/utils/feature-a/feature-b 运行依赖与依赖环
// - plugin-kit 对 core 的 peer 约束；widget/app/internal-tool 为私有包
// - app → feature-x 可选依赖缺失
// - preview-app 钉版预发布 next-lib
// - ui-lib 同时装入 ext-a/ext-b，二者对 peer-lib 声明互斥 peer 范围
// - frozen-consumer 为仓库外部冻结包，其运行依赖范围不可改写
export const FIXTURE_GRAPH: PackageGraph = {
  revision: 1,
  updatedAt: new Date('2026-09-01T00:00:00.000Z').toISOString(),
  nodes: [
    {id: 'core', name: '@studio/core', version: '1.4.2'},
    {id: 'utils', name: '@studio/utils', version: '2.0.3'},
    {id: 'feature-a', name: '@studio/feature-a', version: '1.0.0'},
    {id: 'feature-b', name: '@studio/feature-b', version: '1.0.0'},
    {id: 'plugin-kit', name: '@studio/plugin-kit', version: '3.1.0'},
    {id: 'widget', name: '@studio/widget', version: '2.5.1', private: true},
    {id: 'app', name: '@studio/app', version: '4.2.0', private: true},
    {id: 'internal-tool', name: '@studio/internal-tool', version: '1.2.0', private: true},
    {id: 'preview-app', name: '@studio/preview-app', version: '1.0.0', private: true},
    {id: 'next-lib', name: '@studio/next-lib', version: '1.0.0-beta.2'},
    {id: 'feature-x', name: '@studio/feature-x', version: '0.3.0', external: true},
    {id: 'peer-lib', name: '@studio/peer-lib', version: '1.5.0'},
    {id: 'ext-a', name: 'vendor/ext-a', version: '1.0.0', external: true},
    {id: 'ext-b', name: 'vendor/ext-b', version: '1.0.0', external: true},
    {id: 'ui-lib', name: '@studio/ui-lib', version: '0.9.0'},
    {id: 'frozen-consumer', name: 'vendor/frozen-consumer', version: '2.0.0', external: true},
  ],
  edges: [
    {from: 'utils', to: 'core', kind: 'runtime', range: '^1.0.0'},
    {from: 'feature-a', to: 'utils', kind: 'runtime', range: '^2.0.0'},
    {from: 'feature-b', to: 'utils', kind: 'runtime', range: '^2.0.0'},
    {from: 'feature-a', to: 'feature-b', kind: 'runtime', range: '^1.0.0'},
    {from: 'feature-b', to: 'feature-a', kind: 'runtime', range: '^1.0.0'},
    {from: 'plugin-kit', to: 'core', kind: 'peer', range: '^1.0.0'},
    {from: 'widget', to: 'plugin-kit', kind: 'runtime', range: '^3.0.0'},
    {from: 'widget', to: 'utils', kind: 'runtime', range: '^2.0.0'},
    {from: 'widget', to: 'core', kind: 'optional', range: '>=1.0.0 <3.0.0'},
    {from: 'app', to: 'widget', kind: 'runtime', range: '^2.0.0'},
    {from: 'app', to: 'plugin-kit', kind: 'runtime', range: '^3.0.0'},
    {from: 'app', to: 'internal-tool', kind: 'runtime', range: '^1.0.0'},
    {from: 'app', to: 'feature-x', kind: 'optional', range: '^0.3.0', missing: true},
    {from: 'app', to: 'frozen-consumer', kind: 'runtime', range: '^2.0.0'},
    {from: 'internal-tool', to: 'utils', kind: 'runtime', range: '^2.0.0'},
    {from: 'internal-tool', to: 'core', kind: 'optional', range: '^1.0.0'},
    {from: 'preview-app', to: 'next-lib', kind: 'runtime', range: '1.0.0-beta.2'},
    {from: 'ui-lib', to: 'ext-a', kind: 'runtime', range: '^1.0.0'},
    {from: 'ui-lib', to: 'ext-b', kind: 'runtime', range: '^1.0.0'},
    {from: 'ext-a', to: 'peer-lib', kind: 'peer', range: '^1.0.0'},
    {from: 'ext-b', to: 'peer-lib', kind: 'peer', range: '^2.0.0'},
    {from: 'frozen-consumer', to: 'utils', kind: 'runtime', range: '>=2.0.0'},
    {from: 'frozen-consumer', to: 'plugin-kit', kind: 'runtime', range: '^3.0.0'},
  ],
};

export function cloneFixture(): PackageGraph {
  return JSON.parse(JSON.stringify(FIXTURE_GRAPH)) as PackageGraph;
}
