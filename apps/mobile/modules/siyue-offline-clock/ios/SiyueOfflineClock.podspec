Pod::Spec.new do |s|
  s.name           = 'SiyueOfflineClock'
  s.version        = '0.1.0'
  s.summary        = 'Continuous native clock for bounded offline authorization'
  s.description    = 'Exposes a process-scoped epoch and a sleep-aware monotonic clock.'
  s.author         = 'Siyue'
  s.homepage       = 'https://siyue.app'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
