#!/usr/bin/env ruby
# Adds isolated QA targets to the ignored prebuilt project, reusing installed Pods.
require 'pathname'
require 'xcodeproj'

root = Pathname.new(__dir__).parent
abort 'Only --account is supported as an optional argument' unless ARGV.empty? || ARGV == ['--account']
account = ARGV == ['--account']
qa_name = account ? 'SiyueAccountQA' : 'SiyueNativeQA'
test_name = account ? 'AccountAuthUITests' : 'NativeRecoveryUITests'
bundle_id = account ? 'app.siyue.mobile.accountqa' : 'app.siyue.mobile.qa'
entry_relative = account ? 'account-auth/entry.tsx' : 'native-recovery/entry.tsx'
qa_entitlements = account ? '../e2e/account-auth/simulator.entitlements' : nil
test_entitlements = account ? '../e2e/account-auth/test-runner.entitlements' : nil
project_path = root.join('apps/mobile/ios/Siyue.xcodeproj')
# The account suite compiles its session cases and the screen-driven registration cases into one test
# bundle, so a single build and scheme cover both `-only-testing` filters. The recovery suite keeps its
# single source file.
suite_names = account ? ['AccountAuthUITests.swift', 'RegistrationUITests.swift'] : ["#{test_name}.swift"]
suite_sources = suite_names.map { |name| root.join("apps/mobile/e2e/#{name}") }
source = suite_sources.first
entry = root.join("apps/mobile/e2e/#{entry_relative}")
abort 'Prebuilt iOS project or QA sources missing' unless project_path.directory? && suite_sources.all?(&:file?) && entry.file?
project = Xcodeproj::Project.open(project_path)
app = project.targets.find { |target| target.name == 'Siyue' && target.product_type == 'com.apple.product-type.application' }
abort 'Expected normal application target missing' unless app
release = app.build_configurations.find { |config| config.name == 'Release' }
abort 'Expected Release configuration missing' unless release && release.base_configuration_reference
pods_config = root.join('apps/mobile/ios/Pods/Target Support Files/Pods-Siyue/Pods-Siyue.release.xcconfig')
abort 'Install iOS Pods before preparing the QA target' unless pods_config.file?
abort 'Installed Pods Release configuration does not link Expo' unless pods_config.read.include?('-l"Expo"')
normal_before = Marshal.dump([app.to_hash, app.build_configurations.map(&:to_hash), app.build_phases.map(&:to_hash)])
copy = ->(value) { Marshal.load(Marshal.dump(value)) }
deployment = release.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] || '16.4'

qa = project.targets.find { |target| target.name == qa_name }
if qa && (qa.product_type != 'com.apple.product-type.application' || qa.build_configurations.any? { |c| c.build_settings['SIYUE_NATIVE_QA'] != 'YES' })
  abort 'Existing QA target is not owned by this preparation script; no changes saved'
end
qa ||= project.new_target(:application, qa_name, :ios, deployment)
qa.build_phases.to_a.each do |phase|
  phase.files.to_a.each(&:remove_from_project)
  phase.remove_from_project
end
app.build_phases.each do |original|
  phase = project.new(original.class)
  original.simple_attributes.each { |attribute| phase.public_send("#{attribute.name}=", copy.call(original.public_send(attribute.name))) }
  original.files.each do |original_file|
    file = phase.add_file_reference(original_file.file_ref, true)
    original_file.simple_attributes.each { |attribute| file.public_send("#{attribute.name}=", copy.call(original_file.public_send(attribute.name))) }
  end
  qa.build_phases << phase
end
qa.build_configurations.to_a.reject { |config| config.name == 'Release' }.each(&:remove_from_project)
config = qa.build_configurations.find { |item| item.name == 'Release' } || qa.add_build_configuration('Release', :release)
config.base_configuration_reference = release.base_configuration_reference
config.build_settings = copy.call(release.build_settings).merge(
  'SIYUE_NATIVE_QA' => 'YES',
  'PRODUCT_NAME' => qa_name,
  'PRODUCT_BUNDLE_IDENTIFIER' => bundle_id,
  'ENTRY_FILE' => "$(SRCROOT)/../e2e/#{entry_relative}",
  'INFOPLIST_FILE' => "#{qa_name}-Info.plist"
)
config.build_settings['CODE_SIGN_ENTITLEMENTS'] = qa_entitlements if qa_entitlements
qa.build_configuration_list.default_configuration_name = 'Release'
qa.product_reference.path = "#{qa_name}.app"

test = project.targets.find { |target| target.name == test_name }
if test && (test.product_type != 'com.apple.product-type.bundle.ui-testing' || test.build_configurations.any? { |c| c.build_settings['SIYUE_NATIVE_QA'] != 'YES' })
  abort 'Existing QA test target is not owned by this script; no changes saved'
end
test ||= project.new_target(:ui_test_bundle, test_name, :ios, deployment)
test.add_dependency(qa) unless test.dependencies.any? { |dependency| dependency.target == qa }
test.build_configurations.to_a.reject { |item| item.name == 'Release' }.each(&:remove_from_project)
test_config = test.build_configurations.find { |item| item.name == 'Release' } || test.add_build_configuration('Release', :release)
test_config.build_settings.merge!(
  'SIYUE_NATIVE_QA' => 'YES', 'PRODUCT_BUNDLE_IDENTIFIER' => "#{bundle_id}.uitests",
  'PRODUCT_NAME' => '$(TARGET_NAME)', 'SWIFT_VERSION' => '5.0', 'GENERATE_INFOPLIST_FILE' => 'YES',
  'IPHONEOS_DEPLOYMENT_TARGET' => deployment, 'TARGETED_DEVICE_FAMILY' => '1,2',
  'TEST_TARGET_NAME' => qa_name, 'CODE_SIGN_STYLE' => 'Automatic'
)
test_config.build_settings['CODE_SIGN_ENTITLEMENTS'] = test_entitlements if test_entitlements
test.build_configuration_list.default_configuration_name = 'Release'
attributes = project.root_object.attributes['TargetAttributes'] ||= {}
attributes[test.uuid] ||= {}
attributes[test.uuid]['TestTargetID'] = qa.uuid
group = project.main_group.children.find { |item| item.isa == 'PBXGroup' && item.name == test_name }
group ||= project.main_group.new_group(test_name, '../e2e')
suite_sources.each do |suite_source|
  name = suite_source.basename.to_s
  reference = group.files.find { |file| file.path == name } || group.new_file(name)
  test.source_build_phase.add_file_reference(reference) unless test.source_build_phase.files.any? { |file| file.file_ref == reference }
end

normal_after = Marshal.dump([app.to_hash, app.build_configurations.map(&:to_hash), app.build_phases.map(&:to_hash)])
abort 'Normal target changed unexpectedly; no changes saved' unless normal_before == normal_after
info = Xcodeproj::Plist.read_from_path(root.join('apps/mobile/ios/Siyue/Info.plist'))
info['CFBundleDisplayName'] = qa_name
info.delete('CFBundleURLTypes')
Xcodeproj::Plist.write_to_path(info, root.join("apps/mobile/ios/#{qa_name}-Info.plist"))
project.save
saved_qa = Xcodeproj::Project.open(project_path).targets.find { |target| target.name == qa_name }
saved_release = saved_qa&.build_configurations&.find { |item| item.name == 'Release' }
abort 'QA target lost the app Pods Release configuration; rerun preparation after pod install' unless saved_release&.base_configuration_reference&.uuid == release.base_configuration_reference.uuid
scheme = Xcodeproj::XCScheme.new
scheme.configure_with_targets(qa, test, launch_target: true)
scheme.test_action.build_configuration = 'Release'
scheme.launch_action.build_configuration = 'Release'
scheme.save_as(project_path, test_name, true)
puts "Prepared #{qa_name} and #{test_name}; normal target preserved; no build or test performed."
