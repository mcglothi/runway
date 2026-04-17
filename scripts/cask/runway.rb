cask "runway" do
  version "0.1.0"

  # Update these after each release (run: shasum -a 256 Runway-VERSION-arm64.dmg)
  if Hardware::CPU.arm?
    sha256 "REPLACE_WITH_ARM64_SHA256"
    url "https://github.com/mcglothi/runway/releases/download/v#{version}/Runway-#{version}-arm64.dmg"
  else
    sha256 "REPLACE_WITH_X64_SHA256"
    url "https://github.com/mcglothi/runway/releases/download/v#{version}/Runway-#{version}-x64.dmg"
  end

  name "Runway"
  desc "Real-time AI quota tracker for the macOS menu bar"
  homepage "https://github.com/mcglothi/runway"

  livecheck do
    url :url
    strategy :github_latest
  end

  app "Runway.app"

  zap trash: [
    "~/Library/Application Support/Runway",
    "~/Library/Logs/Runway",
    "~/Library/Preferences/com.mcglothi.runway.plist",
  ]
end
