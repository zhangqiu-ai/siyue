#!/usr/bin/env ruby
# Adds only the UI-test target and its dedicated shared scheme to an already prebuilt project.
require 'pathname'
begin
  require 'xcodeproj'
rescue LoadError
  abort 'xcodeproj is unavailable in this Ruby. Use the Ruby/GEM_HOME environment of CocoaPods; see apps/mobile/e2e/README.md.'
end

root = Pathname.new(__dir__).parent
project_path = root.join('apps/mobile/ios/Siyue.xcodeproj')
source_path = root.join('apps/mobile/e2e/SiyueUITests.swift')
abort "Missing prebuilt project: #{project_path}. Run Expo prebuild and finish pod install first." unless project_path.join('project.pbxproj').file?
abort "Missing test source: #{source_path}" unless source_path.file?
project = Xcodeproj::Project.open(project_path)
app = project.targets.find { |target| target.name == 'Siyue' && target.product_type == 'com.apple.product-type.application' }
abort 'Expected Siyue application target was not found; no changes made.' unless app
name = 'SiyueUITests'
target = project.targets.find { |item| item.name == name }
abort "Existing #{name} is not a UI-test bundle; no changes made." if target && target.product_type != 'com.apple.product-type.bundle.ui-testing'

# Existing app build configurations are inputs only; do not alter signing, identifiers, or deployment targets.
deployment = app.build_configurations.first.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] || '16.4'
target ||= project.new_target(:ui_test_bundle, name, :ios, deployment)
target.add_dependency(app) unless target.dependencies.any? { |dependency| dependency.target == app }
app.build_configurations.each do |app_config|
  config = target.build_configurations.find { |item| item.name == app_config.name }
  config ||= target.add_build_configuration(app_config.name, app_config.type)
  config.build_settings.merge!(
    'PRODUCT_BUNDLE_IDENTIFIER' => 'app.siyue.mobile.uitests',
    'PRODUCT_NAME' => '$(TARGET_NAME)',
    'SWIFT_VERSION' => '5.0',
    'GENERATE_INFOPLIST_FILE' => 'YES',
    'IPHONEOS_DEPLOYMENT_TARGET' => deployment,
    'TARGETED_DEVICE_FAMILY' => '1,2',
    'TEST_TARGET_NAME' => app.name,
    'CODE_SIGN_STYLE' => 'Automatic'
  )
  team = app_config.build_settings['DEVELOPMENT_TEAM']
  config.build_settings['DEVELOPMENT_TEAM'] = team if team && !team.empty?
end
attributes = project.root_object.attributes['TargetAttributes'] ||= {}
attributes[target.uuid] ||= {}
attributes[target.uuid]['TestTargetID'] = app.uuid

group = project.main_group.children.find { |item| item.isa == 'PBXGroup' && item.name == name }
group ||= project.main_group.new_group(name, '../e2e')
reference = group.files.find { |file| file.path == source_path.basename.to_s }
reference ||= group.new_file(source_path.basename.to_s)
unless target.source_build_phase.files.any? { |build_file| build_file.file_ref == reference }
  target.source_build_phase.add_file_reference(reference)
end
project.save

# Generate a dedicated scheme. The Expo Siyue scheme is untouched, including its existing test references.
scheme = Xcodeproj::XCScheme.new
scheme.configure_with_targets(app, target, launch_target: true)
scheme.test_action.build_configuration = 'Release'
scheme.save_as(project_path, name, true)
puts "Prepared #{name} in #{project_path}; no build, install, app launch, or test was performed."
