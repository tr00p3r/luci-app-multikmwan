# OpenWrt SDK build (standard LuCI app layout: root/ + htdocs/).
# Drop this directory into <sdk>/package/luci-app-multikmwan and run
#   make package/luci-app-multikmwan/compile
#
# The release .ipk is produced by build.sh instead; this Makefile follows the
# usual luci.mk conventions but has not been exercised against an SDK.
include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-multikmwan
PKG_VERSION:=1.1.0
PKG_RELEASE:=1
PKG_LICENSE:=Unlicense
PKG_MAINTAINER:=David

LUCI_TITLE:=MultiKmwan - multi-WAN manager for GL.iNet kmwan
LUCI_DESCRIPTION:=LuCI front-end for GL.iNet's kmwan: failover/load-balance mode, \
	per-WAN priority and ratio, per-client WAN preference via policy routing, \
	per-WAN speed tests with automatic ranking, latency/loss/ISP health view.
LUCI_DEPENDS:=+luci-base +curl
LUCI_PKGARCH:=all

define Package/$(PKG_NAME)/conffiles
/etc/config/multikmwan
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
