# v0.2.16
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

"""
DealRegistry
A plain, on-chain address book for EvidenceEscrow deals. Deliberately
minimal: it doesn't deploy contracts and doesn't organize entries by
wallet. It just remembers every deal address it's told about, in
order, so any frontend, on any device, can read the full list back
and filter it locally by checking each deal's own get_parties().

That split, the registry stores addresses, the frontend does the
filtering, keeps this contract small and avoids needing a nested
per-wallet storage structure that was never verified on this runtime.
DynArray[str] was confirmed working first, empirically, with a
throwaway probe, before this was written.
"""

from genlayer import *


class DealRegistry(gl.Contract):
    deals: DynArray[str]

    def __init__(self):
        pass

    @gl.public.write
    def register_deal(self, deal_address: str) -> None:
        """
        Records a deal address, once. Anyone can call this, it's a
        public log, not a permissioned action, but a given address is
        only ever stored once, so calling it again by accident doesn't
        pad the list with duplicates.
        """
        normalized = Address(deal_address).as_hex
        for existing in list(self.deals):
            if existing == normalized:
                return
        self.deals.append(normalized)

    @gl.public.view
    def get_all_deals(self) -> list[str]:
        return list(self.deals)

    @gl.public.view
    def count(self) -> u256:
        return u256(len(self.deals))
