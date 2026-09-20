const { withAppBuildGradle } = require('expo/config-plugins');
const marker = '// Siyue whiteboard workspace bundle inputs';
const block = `
${marker}
tasks.matching { it.name.startsWith("createBundle") && it.name.endsWith("JsAndAssets") }.configureEach {
    inputs.files(fileTree("\${rootDir}/../../../packages/whiteboard") {
        include "src/**", "dist/**", "generated/**"
    })
}
`;
function patch(contents) { return contents.includes(marker) ? contents : contents + block; }
module.exports = config => withAppBuildGradle(config, config => {
  config.modResults.contents = patch(config.modResults.contents);
  return config;
});
module.exports.patch = patch;
