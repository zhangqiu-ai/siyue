#!/usr/bin/env ruby
# Standalone simulator XCTest runner; does not rebuild/change the installed application.
require 'pathname'
require 'fileutils'
require 'xcodeproj'
root = Pathname.new(__dir__).parent
output = Pathname.new(ARGV.fetch(0, '/tmp/siyue-whiteboard-ui-tests'))
FileUtils.mkdir_p(output)
path = output.join('WhiteboardTrial.xcodeproj')
abort "Project already exists: #{path}; use another output directory" if path.exist?
project = Xcodeproj::Project.new(path)
target = project.new_target(:ui_test_bundle, 'WhiteboardTrialUITests', :ios, '16.4')
target.build_configurations.each do |config|
  config.build_settings.merge!(
    'PRODUCT_BUNDLE_IDENTIFIER' => 'app.siyue.whiteboard.uitests',
    'PRODUCT_NAME' => '$(TARGET_NAME)', 'SWIFT_VERSION' => '5.0',
    'GENERATE_INFOPLIST_FILE' => 'YES', 'TARGETED_DEVICE_FAMILY' => '1,2',
    'CODE_SIGNING_ALLOWED' => 'NO'
  )
end
reference = project.main_group.new_file(root.join(ARGV.fetch(1, 'apps/mobile/e2e/WhiteboardTrialUITests.swift')).to_s)
target.source_build_phase.add_file_reference(reference)
project.save
scheme = Xcodeproj::XCScheme.new
scheme.add_build_target(target)
scheme.add_test_target(target)
scheme.test_action.build_configuration = 'Debug'
scheme.save_as(path, 'WhiteboardTrialUITests', true)
puts path
